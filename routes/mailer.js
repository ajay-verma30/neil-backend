// mailer.js
require("dotenv").config();
const SibApiV3Sdk = require("sib-api-v3-sdk");

const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications["api-key"];
apiKey.apiKey = process.env.BREVO_API_KEY;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

async function sendEmail(to, subject, text, html = null) {
  try {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

    sendSmtpEmail.sender = {
      name: process.env.EMAIL_FROM_NAME,
      email: process.env.EMAIL_FROM,
    };
    sendSmtpEmail.to = [{ email: to }];
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.textContent = text;
    if (html) sendSmtpEmail.htmlContent = html;

    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log("✅ Email sent successfully:", data);
    return data;
  } catch (error) {
    console.error("❌ Error sending email:", error.message);
    throw error;
  }
}

module.exports = { sendEmail };
