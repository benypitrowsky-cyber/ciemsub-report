import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import { chromium } from 'playwright';

const CIEM_URL =
  'https://loginseguro.petrobras.com.br/fwca/pages/AuthenticationForm.jsp?successfulUrl=https%3a%2f%2fex-ciem2.petrobras.com.br%3a443%2f&ssoEnabled=False&applicationCatalogId=CIE2&appEnvUid=5013&integratedAuthenticationEnabled=False&logonPage=&hxid=f31e10275f381ca1#';

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Faltou variável de ambiente: ${name}`);
  return v;
}

function safeTs() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function sendEmailWithAttachments({ subject, text, attachments }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: mustEnv('GMAIL_USER'),
      pass: mustEnv('GMAIL_APP_PASSWORD'),
    },
  });

  await transporter.sendMail({
    from: mustEnv('GMAIL_USER'),
    to: mustEnv('EMAIL_TO'),
    subject,
    text,
    attachments: attachments.map((filePath) => ({
      filename: path.basename(filePath),
      path: filePath,
    })),
  });
}

async function clickFirstThatExists(locators, options = {}) {
  for (const locator of locators) {
    if (await locator.count()) {
      await locator.first().click(options);
      return true;
    }
  }
  return false;
}

async function run() {
  // Credenciais CIEM
  const CIEM_USER = mustEnv('CIEM_USER');
  const CIEM_PASS = mustEnv('CIEM_PASS');

  // E-mail
  const EMAIL_TO = mustEnv('EMAIL_TO'); // valida existência

  // Pasta de saída (vai virar artifact)
  const outDir = path.resolve('output');
  fs.mkdirSync(outDir, { recursive: true });

  const ts = safeTs();
  const screenshotVisao = path.join(outDir, `ciemsub-visao-servico-${ts}.png`);
  const screenshotMon = path.join(outDir, `ciemsub-monitoramento-${ts}.png`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  try {
    // 1) Access CIEMSub (login page)
    await page.goto(CIEM_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });

    // 2) Click '(Legado) Usuário externo'
    await page.getByRole('link', { name: /\(Legado\)\s*Usuário externo/i }).click({ timeout: 60_000 });

    // 3) Input 'Usuário'
    // Ajuste se a label for diferente (id/name/placeholder etc.)
    await page.getByLabel(/Usuário/i).fill(CIEM_USER);

    // 4) Input 'Senha externa'
    await page.getByLabel(/Senha externa/i).fill(CIEM_PASS);

    // 5) Entrar (link ou botão)
    const clickedEntrar = await clickFirstThatExists(
      [
        page.getByRole('link', { name: /Entrar/i }),
        page.getByRole('button', { name: /Entrar/i }),
        page.locator('a:has-text("Entrar")'),
        page.locator('button:has-text("Entrar")'),
      ],
      { timeout: 60_000 }
    );
    if (!clickedEntrar) throw new Error('Não encontrei o "Entrar" (link/botão).');

    // Aguarda pós-login
    await page.waitForLoadState('networkidle', { timeout: 120_000 });

    // 6) Click menu (se existir)
    // (IMPORTANTE: esse trecho é o mais dependente do HTML real)
    await clickFirstThatExists(
      [
        page.getByRole('button', { name: /menu/i }),
        page.getByLabel(/menu/i),
        page.locator('[aria-label*="menu" i]'),
        page.locator('button:has-text("Menu")'),
      ],
      { timeout: 15_000 }
    );
    // Se não clicar, seguimos (às vezes o menu já está aberto)

    // 7) "visão serviço"
    await page.getByRole('link', { name: /visão serviço/i }).click({ timeout: 60_000 });

    // 8) Wait loading process (15 sec)
    await page.waitForTimeout(15_000);

    // 9) Screenshot schedule
    await page.screenshot({ path: screenshotVisao, fullPage: true });

    // 10) Abrir "Monitoramento" em nova janela
    const [monitorPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 60_000 }),
      page.getByRole('link', { name: /Monitoramento/i }).click({ timeout: 60_000 }),
    ]);

    // 11) Esperar nova janela
    await monitorPage.waitForLoadState('domcontentloaded', { timeout: 120_000 });
    await monitorPage.waitForTimeout(3_000);

    // 12) Screenshot monitoramento
    await monitorPage.screenshot({ path: screenshotMon, fullPage: true });

    // 13) Enviar e-mail (sem abrir Gmail via browser)
    const subject = `Relatório CIEMSub - ${new Date().toLocaleString('pt-BR')}`;
    const text =
      `Segue o relatório CIEMSub.\n\n` +
      `Anexos:\n- visão serviço\n- monitoramento\n\n` +
      `Destino: ${EMAIL_TO}\n`;

    await sendEmailWithAttachments({
      subject,
      text,
      attachments: [screenshotVisao, screenshotMon],
    });
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
