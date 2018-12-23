const path = require("path");
const config = require('./config')

const Telegraf = require('telegraf')
const { Extra, Markup } = Telegraf
const Composer = require('telegraf/composer')
const Stage = require('telegraf/stage')
const { enter, leave, reenter } = Stage
const Scene = require('telegraf/scenes/base')
const WizardScene = require('telegraf/scenes/wizard')

const RedisSession = require('telegraf-session-redis')

const TelegrafI18n = require('telegraf-i18n')

const RutrackerApi = require('rutracker-api')
const rutracker = new RutrackerApi()

const Transmission = require('transmission-promise')

// Safe get
const get = (path, object) =>
    path.reduce((xs, x) =>
        (xs && xs[x]) ? xs[x] : null, object)

// Search scene
const searchScene = new Scene('searchScene')
    .command('start', (ctx) => {
        return ctx.reply(ctx.i18n.t('start'))
    })
    .command('en', (ctx) => {
        ctx.i18n.locale('en')
        return ctx.replyWithHTML(ctx.i18n.t('greeting'))
    })
    .command('ru', (ctx) => {
        ctx.i18n.locale('ru')
        return ctx.replyWithHTML(ctx.i18n.t('greeting'))
    })
    .command('credentialsSetRutracker', enter('credentialsSetRutrackerScene'))
    .command('transmissionConfigure', enter('transmissionConfigurationWizardScene'))
    .command('transmissionSetPath', (ctx) => {
        if (undefined != ctx.session.transmissionConfig) {
            ctx.session.transmissionPath = ctx.message.text.substring("/transmissionSetPath ".length)
            return ctx.reply(ctx.i18n.t('transmission_path_set'))
        }
        return ctx.reply(ctx.i18n.t('transmission_not_configured'))
    })
    .command('transmissionStatus', (ctx) => {
        if (undefined != ctx.session.transmissionConfig) {
            var transmission = new Transmission(ctx.session.transmissionConfig)
            return transmission.get(false, ['id', 'name', 'totalSize', 'status', 'rateDownload', 'leftUntilDone', 'addedDate'])
                .then(res => {
                    var torrents = res.torrents.sort((a, b) => a.addedDate < b.addedDate)

                    var i = 0
                    var messages = [""]

                    torrents.forEach((torrent, tIndex) => {
                        var itemNumber = tIndex + 1
                        var downloadRateDescription = torrent.rateDownload > 0 ? `| DLRATE ${formatBytes(torrent.rateDownload)}/s, LEFT ${formatBytes(torrent.leftUntilDone)}` : ``
                        var itemDesription = `\n${itemNumber} | ADDED ${unixtimestampToString(torrent.addedDate)} | ${formatBytes(torrent.totalSize)}, ${torrentStatusDescription(torrent.status)} ${downloadRateDescription} \n\`\`\`\n${torrent.name}\n\`\`\`\n-----------------\n`

                        if (messages[i].length + itemDesription.length >= 4096) {
                            i++
                            messages.push("")
                        }
                        messages[i] += itemDesription
                    })

                    if (messages.length == 0) {
                        return ctx.reply(ctx.i18n.t('transmission_no_torrents'))
                    }

                    var sequence = Promise.resolve()

                    messages.forEach(m => {
                        sequence = sequence.then(function () {
                            return ctx.replyWithMarkdown(m)
                        })
                    })

                    return sequence
                })
                .catch(err => ctx.reply(ctx.i18n.t('transmission_error') + '\n' + JSON.stringify(err)))
        }
        return ctx.reply(ctx.i18n.t('transmission_not_configured'))
    })
    .command('transmissionStopAll', (ctx) => {
        if (undefined != ctx.session.transmissionConfig) {
            var transmission = new Transmission(ctx.session.transmissionConfig)
            return transmission.stopAll().then((res) => ctx.reply(ctx.i18n.t('transmission_stopped_all')))
        }
        return ctx.reply(ctx.i18n.t('transmission_not_configured'))
    })
    .command('transmissionStartAll', (ctx) => {
        if (undefined != ctx.session.transmissionConfig) {
            var transmission = new Transmission(ctx.session.transmissionConfig)
            return transmission.startAll().then((res) => ctx.reply(ctx.i18n.t('transmission_started_all')))
        }
        return ctx.reply(ctx.i18n.t('transmission_not_configured'))
    })
    .command('search', (ctx) => {
        ctx.session.searchTerm = ctx.message.text.substring("/search ".length)
        return ctx.reply(ctx.i18n.t('begin_searching', { term: ctx.session.searchTerm }))
            .then(() => searchPromise(ctx))
    })
    .command((ctx) => {
        if (/^\/\d{1,3}$/.test(ctx.message.text)) {
            ctx.session.selectedTorrentIndex = parseInt(ctx.message.text.substring("/".length)) - 1
            return selectTorrentPromise(ctx)
        }
    })
    .hears(/^(Н|н)ай(д|т)и /, (ctx) => {
        ctx.session.searchTerm = ctx.message.text.substring(ctx.match[0].length)
        return ctx.reply(ctx.i18n.t('begin_searching', { term: ctx.session.searchTerm }))
            .then(() => searchPromise(ctx))
    })
    .hears(/^\d{1,3}$/, (ctx) => {
        ctx.session.selectedTorrentIndex = ctx.match[0] - 1
        return selectTorrentPromise(ctx)
    })
    .hears(/^⬇️ Download/, (ctx) => {
        if (undefined != ctx.session.pendingDownloadUri
            && undefined != ctx.session.transmissionConfig) {

            var transmission = new Transmission(ctx.session.transmissionConfig)
            var options = {}
            if (undefined != ctx.session.transmissionPath) {
                options['download-dir'] = ctx.session.transmissionPath
            }

            return transmission.addUrl(ctx.session.pendingDownloadUri.toString(), options)
                .then(res => ctx.reply(ctx.i18n.t('transmission_download_added')))
                .catch(err => ctx.reply(ctx.i18n.t('transmission_error') + '\n' + JSON.stringify(err)))
        }
        return ctx.reply(ctx.i18n.t('pending_link_not_found'))
    })
    .hears(/^⏏️ Clear/, (ctx) => {
        return ctx.scene.leave().then(() => ctx.reply(ctx.i18n.t('search_is_over')))
    })
    .on('message', (ctx) => ctx.reply(ctx.i18n.t('try_search')))


// Credentials set rutracker scene
const credentialsSetRutrackerScene = new Scene('credentialsSetRutrackerScene')
    .enter((ctx) => {
        if (undefined == ctx.session.credentials)
            ctx.session.credentials = {}

        ctx.session.credentials.rutracker = {}
        return ctx.reply(ctx.i18n.t('enter_login'))
    })
    .hears(/^[A-Za-z]+$/, (ctx) => {
        return new Promise((resolve, reject) => {
            console.log('credentialsSetRutrackerScene message handler')
            if (null == get(['credentials', 'rutracker', 'login'], ctx.session)) {
                ctx.session.credentials.rutracker = {}
                ctx.session.credentials.rutracker.login = ctx.message.text
                ctx.reply(ctx.i18n.t('entered_login'))
                    .then(() => resolve())
            }
            else if (null == get(['credentials', 'rutracker', 'password'], ctx.session)) {
                ctx.session.credentials.rutracker.password = ctx.message.text
                ctx.reply(ctx.i18n.t('entered_password'))
                    .then(() => rutrackerLoginPromise(ctx))
                    .then(() => ctx.reply(ctx.i18n.t('success')))
                    .then(() => ctx.scene.leave())
                    .then(() => {
                        resolve()
                    })
                    .catch((err) => {
                        ctx.reply(ctx.i18n.t('authentication_error'))
                            .then(() => ctx.scene.leave())
                            .then(() => {
                                resolve()
                            })
                    })
            }
            else {
                ctx.scene.leave()
                    .then(() => {
                        resolve()
                    })
            }
        })
    })
    .leave((ctx) => {
        return ctx.reply(ctx.i18n.t('login_is_set', { login: get(['credentials', 'rutracker', 'login'], ctx.session) }))
    })

// Transmission configuration wizard scene
const transmissionConfigurationWizardScene = new WizardScene('transmissionConfigurationWizardScene',
    (ctx) => {
        ctx.session.pendingTransmissionConfig = {
            host: '', //  'localhost'
            port: 9091, //  9091
            username: '',
            password: '',
            ssl: false, // use https
            url: '/transmission/rpc', // rpc url default '/transmission/rpc'
        }
        return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_enter_hostname'))
            .then(() => ctx.wizard.next())
    },
    (ctx) => {
        var text = (ctx.message.text.match(/^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/) || [""])[0]
        if (text.length > 0) {
            ctx.session.pendingTransmissionConfig.host = text
            return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_enter_port')).then(() => ctx.wizard.next())
        }
        return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_error'))

    },
    (ctx) => {
        var text = (ctx.message.text.match(/^([0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/) || [""])[0]
        if (text.length > 0) {
            ctx.session.pendingTransmissionConfig.port = text
            return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_enter_http')).then(() => ctx.wizard.next())
        }
        return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_error'))

    },
    (ctx) => {
        var text = ctx.message.text
        if (text == 'HTTP' || text == 'HTTPS') {
            ctx.session.pendingTransmissionConfig.ssl = (text == 'HTTPS')
            return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_enter_username')).then(() => ctx.wizard.next())
        }
        return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_error'))

    },
    (ctx) => {
        var text = (ctx.message.text.match(/^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/) || [""])[0]
        if (text.length > 0) {
            ctx.session.pendingTransmissionConfig.username = text
            return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_enter_password')).then(() => ctx.wizard.next())
        }
        return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_error'))
    },
    (ctx) => {
        var text = (ctx.message.text.match(/^.{1,150}$/) || [""])[0]
        if (text.length > 0) {
            ctx.session.pendingTransmissionConfig.password = text
            return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_enter_done')).then(() => ctx.wizard.next()).then(() => ctx.wizard.steps[ctx.wizard.cursor](ctx))
        }
        return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_error'))
    },
    (ctx) => {
        ctx.session.transmissionConfig = ctx.session.pendingTransmissionConfig
        ctx.session.pendingTransmissionConfig = null
        return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_enter_configuration_saved'))
            .then(() => ctx.wizard.next()).then(() => ctx.wizard.steps[ctx.wizard.cursor](ctx))
    },
    (ctx) => {
        return ctx.reply(ctx.i18n.t('transmission_configuration_wizard_enter_connecting'))
            .then(() => {
                var transmission = new Transmission(ctx.session.transmissionConfig)
                return transmission.sessionStats()
            })
            .then(res => ctx.reply(ctx.i18n.t('transmission_configuration_wizard_enter_connecting_success', { count: res.torrentCount })).then(() => ctx.scene.leave()))
            .catch(err => ctx.reply(ctx.i18n.t('transmission_configuration_wizard_enter_connecting_error', { err: err.toString() })).then(() => ctx.scene.leave()))
    }
)

// Bot creation
const bot = new Telegraf(config.HTTP_API_TOKEN)    // instantiate a bot using our token.

// Next we create and plug middlewares. Pay attention to the order. It is important.

// 1) Response time middleware
bot.use((ctx, next) => {
    const start = new Date()
    return next(ctx).then(() => {
        const ms = new Date() - start
        console.log('Response time %sms', ms)
    })
})

// 2) Sticky redis db session to store data between reloads
const session = new RedisSession({
    store: {
        host: config.SESSION_HOST,
        port: config.SESSION_PORT
    }
})
bot.use(session.middleware())

// 3) Localization support
/* 
yaml and json are ok
Example directory structure:
├── locales
│   ├── en.yaml
│   ├── en-US.yaml
│   ├── it.json
│   └── ru.yaml
└── bot.js
*/
const i18n = new TelegrafI18n({
    useSession: true,
    defaultLanguage: 'en',
    allowMissing: true,
    directory: path.resolve(__dirname, 'locales')
})
bot.use(i18n.middleware())

// 4) Service middleware for logging, access, special commands
bot.use((ctx, next) => {
    console.log('Message from user', ctx.chat.username, 'recieved:', ctx.message.text)
    if (config.ONLY_PRIVATE_CHAT == 1 && !(ctx.chat.type == 'private')) {
        return ctx.reply(ctx.i18n.t('private_chat_warning')).then(() => ctx.leaveChat())
    }
    if (config.ONLY_USERNAME.length > 0 && !(ctx.chat.username == config.ONLY_USERNAME)) {
        return ctx.reply(ctx.i18n.t('username_warning'))
    }
    if (ctx.message.text == '/wipe') {
        ctx.session = {}
        return ctx.reply('session wiped').then(() => next(ctx))
    }
    return next(ctx)
})

// 5) Stage middleware for business logic
const stage = new Stage([searchScene, credentialsSetRutrackerScene, transmissionConfigurationWizardScene], { default: 'searchScene' })
bot.use(stage.middleware())

// Critical error handler
bot.catch((err) => {
    console.log('Ooops', err)
})

// We can get bot nickname from bot informations. This is particularly useful for groups.
bot.telegram.getMe().then((bot_informations) => {
    bot.options.username = bot_informations.username
    console.log("Server has initialized bot nickname. Nick: " + bot_informations.username)
})

// Main business logic functions

const rutrackerLoginPromise = (ctx) => {
    return new Promise((resolve, reject) => {
        if (ctx.session.credentials && ctx.session.credentials.rutracker) {
            var { login, password } = ctx.session.credentials.rutracker
            rutracker.login({ username: login, password: password })
                .then(() => {
                    console.log('Authorized at Rutracker as', login)
                    resolve()
                })
                .catch(err => {
                    console.error('Error authorizing at Rutracker as', login, "\n", err)
                    reject(err)
                })
        }
        else {
            reject({ sendMessage: ctx.i18n.t('authentication_warning') })
        }
    })

}

const searchPromise = (ctx) => {
    var searchTerm = ctx.session.searchTerm || ''
    console.log('Incoming search request with term:', searchTerm)
    return new Promise((resolve, reject) => {
        rutrackerLoginPromise(ctx)
            .then(() => rutracker.search({ query: searchTerm, sort: 'downloads', order: 'desc' }))
            .then(torrents => {
                console.log(torrents)
                torrents.filter(t => t.seeds > 0)
                ctx.session.pendingSearchResults = []
                var i = 0
                var messages = [""]

                torrents.forEach((torrent, tIndex) => {
                    var itemNumber = tIndex + 1
                    var itemDesription = `\n/${itemNumber} | ${formatBytes(torrent.size)}, ${torrent.seeds} SEED, ${torrent.downloads} DL\n\`\`\`\n${torrent.title}\n\`\`\`\n-----------------\n`
                    ctx.session.pendingSearchResults.push({ id: torrent.id, title: torrent.title })

                    if (messages[i].length + itemDesription.length >= 4096) {
                        i++
                        messages.push("")
                    }
                    messages[i] += itemDesription
                })

                if (messages.length == 0) {
                    return Promise.reject({ sendMessage: ctx.i18n.t('no_results_found') })
                }

                var sequence = Promise.resolve()

                sequence = sequence.then(function () {
                    return ctx.replyWithMarkdown(ctx.i18n.t('here_is_what_i_found'))
                })

                messages.forEach(m => {
                    sequence = sequence.then(function () {
                        return ctx.replyWithMarkdown(m)
                    })
                })

                return sequence
            })
            .then(() => {
                return ctx.reply(ctx.i18n.t('search_complete'))
            })
            .then(() => {
                resolve()
            })
            .catch(err => {
                console.log(err)
                if (err.sendMessage) {
                    ctx.replyWithMarkdown(err.sendMessage)
                    resolve()
                }
                else {
                    reject(err)
                }
            })
    })
}

const selectTorrentPromise = ((ctx) => {
    return new Promise((resolve, reject) => {
        var index = ctx.session.selectedTorrentIndex || 0
        var sequence = Promise.resolve()
        if (undefined != ctx.session.pendingSearchResults
            && ctx.session.pendingSearchResults.length > 0
            && ctx.session.pendingSearchResults[index] != undefined) {
            // pending search
            var torrentId = ctx.session.pendingSearchResults[index].id
            var torrentTitle = ctx.session.pendingSearchResults[index].title
            var magnetLink = ""
            sequence
                .then(() => ctx.replyWithMarkdown(ctx.i18n.t('you_picked_torrent', { index: index + 1, title: torrentTitle })))
                .then(() => rutrackerLoginPromise(ctx))
                .then(() => rutracker.getMagnetLink(torrentId))
                .then(uri => {
                    magnetLink = uri
                    return ctx.replyWithMarkdown(ctx.i18n.t('magnet_link_is', { uri: uri }))
                })
                .then(() => {
                    if (undefined != ctx.session.transmissionConfig) {
                        ctx.session.pendingDownloadUri = magnetLink
                        return ctx.reply(ctx.i18n.t('download_suggestion'),
                            Markup.keyboard([['⬇️ Download', '⏏️ Clear']]).oneTime().resize().extra())
                            .then(() => { resolve() })
                    }
                    else {
                        resolve()
                    }
                })

                .catch(err => {
                    reject(err)
                })
        }
        else {
            resolve()
        }
    })
})

// Helper functions 
function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " Bytes"
    else if (bytes < 1048576) return (bytes / 1024).toFixed(3) + " KB"
    else if (bytes < 1073741824) return (bytes / 1048576).toFixed(3) + " MB"
    else return (bytes / 1073741824).toFixed(3) + " GB"
}

function torrentStatusDescription(number) {
    switch (number) {
        case 0: return 'STOPPED'
        case 1: return 'CHECK_WAIT'
        case 2: return 'CHECK'
        case 3: return 'DOWNLOAD_WAIT'
        case 4: return 'DOWNLOAD'
        case 5: return 'SEED_WAIT'
        case 6: return 'SEED'
        case 7: return 'ISOLATED'
        default: return 'UNKNOWN'
    }
}

function unixtimestampToString(timestamp) {
    var date = new Date(timestamp * 1000)
    var formattedDate = ('0' + date.getDate()).slice(-2) + '/' + ('0' + (date.getMonth() + 1)).slice(-2) + '/' + date.getFullYear() + ' ' + ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2)
    return formattedDate
}

// Start bot polling in order to not terminate Node.js application.
bot.startPolling()