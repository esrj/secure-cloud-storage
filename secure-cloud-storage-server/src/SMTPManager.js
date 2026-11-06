/**
 * This file handles communication with SMTP server and send mails.
 */
import nodemailer from 'nodemailer'
import ConfigManager from './ConfigManager.js'
import { MailerSend, EmailParams, Sender, Recipient } from 'mailersend'
import { logger } from './Logger.js'

// Create a transporter for SMTP
let transporter
let mailerSend
let sentFrom
if (ConfigManager.smtp.enabled) {
  if (ConfigManager.smtp.useMailerSend) {
    // Use mailsend API
    mailerSend = new MailerSend({
      apiKey: ConfigManager.smtp.apiKey
    })
    sentFrom = new Sender(ConfigManager.smtp.from, 'Cloud Server')
    logger.info('SMTP Server is ready to take our messages')
  } else {
    // Use nodemailer API
    transporter = nodemailer.createTransport({
      host: ConfigManager.smtp.host,
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: ConfigManager.smtp.user,
        pass: ConfigManager.smtp.pass
      }
    })
    // Verify connection
    transporter.verify((error, success) => {
      if (error) logger.error(error)
      else logger.info('SMTP Server is ready to take our messages')
    })
  }
}

/**
 * Send the email authentication code to certain email with certain name.
 * @param {string} email 
 * @param {string} name 
 * @param {string} auth 
 * @returns 
 */
export async function sendEmailAuth(email, name, auth) {
  if (!ConfigManager.smtp.enabled) return
  if (ConfigManager.smtp.useMailerSend) {
    const recipients = [new Recipient(email, name)]
    const emailParams = new EmailParams()
      .setFrom(sentFrom)
      .setTo(recipients)
      // .setReplyTo(sentFrom)
      .setSubject('機敏雲端驗證碼')
      .setHtml(`<b>您的驗證碼是 ${auth}，請在${ConfigManager.settings.emailAuthExpireTimeMin}分鐘內輸入完畢</b>`)
      .setText(`您的驗證碼是 ${auth}，請在${ConfigManager.settings.emailAuthExpireTimeMin}分鐘內輸入完畢`)

    await mailerSend.email.send(emailParams)
  } else {
    const mailContext = {
      from: ConfigManager.smtp.from, // sender address
      to: email, // list of receivers
      subject: '機敏雲端驗證碼', // Subject line
      text: `您的驗證碼是 ${auth}，請在${ConfigManager.settings.emailAuthExpireTimeMin}分鐘內輸入完畢`, // plain text body
      html: `<b>您的驗證碼是 ${auth}，請在${ConfigManager.settings.emailAuthExpireTimeMin}分鐘內輸入完畢</b>` // html body
    }

    await transporter.sendMail(mailContext)
  }
}

console.debug('SMTPManager.js loaded.')
