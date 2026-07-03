/**
 * Transactional email port. Production wires a provider (Resend/Postmark/SES);
 * development logs, tests capture. Plaintext passwords never pass through here.
 */
export interface Mail {
  to: string
  subject: string
  text: string
}

export interface Mailer {
  send(mail: Mail): Promise<void>
}

export class ConsoleMailer implements Mailer {
  async send(mail: Mail): Promise<void> {
    console.log(`[mail] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`)
  }
}

export class MemoryMailer implements Mailer {
  sent: Mail[] = []
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail)
  }
}
