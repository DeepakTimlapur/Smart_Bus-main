import nodemailer from "nodemailer"

interface EmailResult {
  sent: boolean
  messageId?: string
  error?: string
}

export async function sendStudentCredentialsEmail(
  studentName: string,
  studentId: string,
  toEmail: string,
  plainPassword: string
): Promise<EmailResult> {
  const host = process.env.EMAIL_HOST || process.env.SMTP_HOST
  const port = parseInt(process.env.EMAIL_PORT || process.env.SMTP_PORT || "587", 10)
  const user = process.env.EMAIL_USER || process.env.SMTP_USERNAME
  const pass = process.env.EMAIL_PASSWORD || process.env.SMTP_PASSWORD
  const from = process.env.EMAIL_FROM || process.env.SMTP_FROM || user || "no-reply@smartbus.transit.org"

  if (!host || !user || !pass) {
    // SMTP credentials not configured in environment
    return {
      sent: false,
      error: "Email service is not configured.",
    }
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      connectionTimeout: 8000,
      greetingTimeout: 5000,
    })

    const mailOptions = {
      from: `"Smart Bus Transit OS" <${from}>`,
      to: toEmail,
      subject: `Smart Bus System — Your Student Transit Credentials (${studentId})`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0f1115; color: #f4f1ea; border-radius: 8px;">
          <h2 style="color: #00e676; margin-top: 0; letter-spacing: 0.05em;">Smart Bus Transit OS</h2>
          <p style="font-size: 15px; color: #ccc;">Hello <strong>${studentName}</strong>,</p>
          <p style="font-size: 14px; color: #bbb; line-height: 1.6;">
            Your student bus transit account has been officially created. You can use these credentials to access your live bus tracking, route status, and fee records.
          </p>

          <div style="background: #191c22; padding: 18px 24px; border-radius: 6px; border-left: 4px solid #00e676; margin: 24px 0;">
            <p style="margin: 6px 0; font-size: 14px;"><strong>Student ID / Username:</strong> <span style="font-family: monospace; color: #00e676; font-size: 16px;">${studentId}</span></p>
            <p style="margin: 6px 0; font-size: 14px;"><strong>Temporary Password:</strong> <span style="font-family: monospace; color: #fff; font-size: 16px; background: #222; padding: 2px 8px; border-radius: 4px;">${plainPassword}</span></p>
          </div>

          <p style="font-size: 13px; color: #888; line-height: 1.5;">
            Please log in and update your password immediately. Do not share your login credentials with anyone.
          </p>
          <hr style="border: 0; border-top: 1px solid #292d36; margin: 24px 0;" />
          <p style="font-size: 11px; color: #666; margin-bottom: 0;">Automated Dispatch — Campus Transit Management Operations</p>
        </div>
      `,
    }

    const info = await transporter.sendMail(mailOptions)
    return {
      sent: true,
      messageId: info.messageId,
    }
  } catch (err: any) {
    return {
      sent: false,
      error: err.message || "Failed to dispatch email",
    }
  }
}
