/**
 * Optional separate Electron profile, so two clients (two accounts) can run on
 * one machine at the same time — e.g. an admin and a normal user for demos.
 *
 *   CLIENT_PROFILE=test npm run dev
 *     userData  : <default userData>-test   (keys, wallet, config, SQLite backup)
 *     logs      : <default logs>-test
 *
 * This module MUST be the first import of main/index.js: every other module
 * reads app.getPath('userData') while it is being imported (GlobalValueManager,
 * KeyManager, DatabaseManager, Logger), so the path has to be redirected before
 * they are evaluated. Unset or "default" keeps the normal profile.
 */
import { app } from 'electron'

const profile = (process.env.CLIENT_PROFILE || '').trim()
if (profile && profile !== 'default') {
  const safe = profile.replace(/[^\w.-]+/g, '_')
  const userData = `${app.getPath('userData')}-${safe}`
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  app.setPath('logs', `${app.getPath('logs')}-${safe}`)
  console.log(`[profile] CLIENT_PROFILE=${safe} → userData=${userData}`)
}
