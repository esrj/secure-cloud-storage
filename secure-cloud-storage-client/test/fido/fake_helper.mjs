// Stand-in for fido_helper.py used by FidoProvider.test.mjs. Behaviour is chosen by
// the FAKE_MODE env var, and it speaks the same newline-delimited JSON protocol.
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const lines = rl[Symbol.asyncIterator]()
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const next = async () => JSON.parse((await lines.next()).value)
const mode = process.env.FAKE_MODE

const req = await next()
const secret = Buffer.alloc(32, 7).toString('base64url')

if (mode === 'register') {
  send({ type: 'event', event: 'uv' })
  send({ type: 'event', event: 'uv-failed', retriesLeft: 2 })
  process.stdout.write('this line is not json\n')
  send({
    type: 'result',
    credential: { id: 'Y3JlZA', clientDataJSON: 'e30', attestationObject: 'AA', echo: req },
    secret
  })
} else if (mode === 'pin') {
  send({ type: 'event', event: 'uv-blocked' })
  send({ type: 'pin-request', retries: 7 })
  const { pin } = await next()
  if (pin === '123456') send({ type: 'result', assertion: { id: 'Y3JlZA' }, secret })
  else send({ type: 'error', code: 'PIN_INVALID', message: 'bad pin' })
} else if (mode === 'error') {
  send({ type: 'error', code: 'NO_DEVICE', message: 'No FIDO2 security key found' })
} else if (mode === 'crash') {
  process.stderr.write('Traceback: boom\n')
  process.exit(3)
} else if (mode === 'hang') {
  setInterval(() => {}, 1000)
}
rl.close()
