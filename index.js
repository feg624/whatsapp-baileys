require('dotenv').config()

const express = require('express')
const qrcode = require('qrcode')
const bodyParser = require('body-parser')
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  // useMultiFileAuthState,
} = require('@whiskeysockets/baileys')
const { useCloudflareR2AuthState } = require('./r2-auth-store')
// const fs = require('fs').promises
const Boom = require('@hapi/boom')
const P = require('pino')
const jwt = require('jsonwebtoken')

const app = express()
const port = 10000

app.use(bodyParser.json())

let sock = null
let qrImageData = '' // holds the base64 QR code
let isConnected = false

const delay = ms => new Promise(res => setTimeout(res, ms))

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.sendStatus(401) // Unauthorized
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, sub) => {
    if (err) {
      return res.sendStatus(403) // Forbidden
    }
    req.sub = sub // attach decoded payload
    next()
  })
}

app.get('/health', async (req, res) => {
  res.send('UP')
})

app.get('/qr', authenticateJWT, async (req, res) => {
  if (isConnected) {
    return res.send('<h2>✅ Already connected to WhatsApp!</h2>')
  }

  await startWhatsApp()
  await delay(5000)

  if (qrImageData) {
    res.send(`
      <h2>Scan the QR Code:</h2>
      <img src="${qrImageData}" />
    `)
  } else {
    res.send('<h2>⏳ Waiting for QR code...</h2>')
  }
})

// Send message to group
app.post('/send', authenticateJWT, async (req, res) => {
  if (!isConnected || !sock) {
    // return res.status(400).json({ error: 'Not connected to WhatsApp' })
    await startWhatsApp()
    await delay(5000)
    if (!isConnected || !sock) {
      return res.status(400).json({ error: 'Not connected to WhatsApp' })
    }
  }

  const { jid, message } = req.body

  if (!jid || !message) {
    return res.status(400).json({ error: 'Missing jid or message in request body' })
  }

  try {
    await sock.sendMessage(jid, { text: message })
    res.json({ success: true, sent: { jid, message } })
  } catch (err) {
    console.error('Error sending message:', err)
    res.status(500).json({ error: 'Failed to send message', details: err.message })
  } finally {
    await delay(5000)
    await sock.end()
  }
})

// WhatsApp + Baileys logic
async function startWhatsApp() {
  // const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { state, saveCreds, clearCreds } = await useCloudflareR2AuthState()
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    // console.log(connection)
    // console.log((lastDisconnect?.error)?.output?.statusCode)

    if (qr) {
      // Convert QR to base64 image
      qrImageData = await qrcode.toDataURL(qr)
      console.log(`🔗 New QR generated. Open http://localhost:${port}/qr to scan.`)
    }

    if (connection === 'close') {
      sock = null
      isConnected = false
      qrImageData = ''
      console.log('✅ WhatsApp disconnected.')

      // console.log(lastDisconnect)

      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode === DisconnectReason.restartRequired
      if (shouldReconnect) {
        console.log('Should reconnect...')
        startWhatsApp()
      }

      if ((lastDisconnect?.error)?.output?.statusCode === DisconnectReason.loggedOut) {
        // await fs.rm('auth_info', {recursive: true, force: true})
        await clearCreds()
      }
    } else if (connection === 'open') {
      isConnected = true
      qrImageData = ''
      console.log('✅ WhatsApp connected.')
    }
  })
}

// startWhatsApp()

// Start Express server
app.listen(port, () => {
  console.log(`🚀 Express server running at http://localhost:${port}`)
})
