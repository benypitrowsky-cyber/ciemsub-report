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

async function saveDebugSnapshot(page, outDir, prefix) {
  const ts = safeTs();
  const shot = path.join(outDir, `${prefix}-${ts}.png`);
  const html = path.join(outDir, `${prefix}-${ts}.html`);

  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  const content = await page.content().catch(() => null);
  if (content) fs.writeFileSync(html, content, 'utf8');
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

async function fillFirstThatExists(locators, value, options = {}) {
  for (const locator of locators) {
    if (await locator.count()) {
      const el = locator.first();
      await el.waitFor({ state: 'visible', timeout: options.timeout ?? 15_000 });
      await el.fill(value, { timeout: options.timeout ?? 15_000 });
      return true;
    }
  }
  return false;
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

async function run() {
  const CIEM_USER = mustEnv('CIEM_USER');
  const CIEM_PASS = mustEnv('CIEM_PASS');
  mustEnv('EMAIL_TO');

  const outDir = path.resolve('output');
  fs.mkdirSync(outDir, { recursive: true });

  const ts = safeTs();
  const screenshotVisao = path.join(outDir, `ciemsub-visao-servico-${ts}.png`);
  const screenshotMon = path.join(outDir, `ciemsub-monitoramento-${ts}.png`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    // Login page
    await page.goto(CIEM_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });

    // Click "(Legado) Usuário externo"
    await page.getByRole('link', { name: /\(Legado\)\s*Usuário externo/i }).click({ timeout: 60_000 });

    // Pequena folga para renderizar/alterar DOM
    await page.waitForTimeout(1_000);

    // Preenche Usuário (fallbacks)
    const userFilled = await fillFirstThatExists(
      [
        // 1) label (se existir)
        page.getByLabel(/Usuário/i),
        // 2) placeholder / aria-label
        page.getByPlaceholder(/Usuário/i),
        page.locator('input[aria-label*="Usu" i]'),
        // 3) name/id comuns
        page.locator('input[name="usuario"]'),
        page.locator('input[name="user"]'),
        page.locator('input[name="username"]'),
        page.locator('input[id="usuario"]'),
        page.locator('input[id="user"]'),
        page.locator('input[id="username"]'),
        // 4) heurística: primeiro input de texto visível do form
        page.locator('form input[type="text"]:visible'),
        page.locator('form input:not([type]):visible'),
      ],
      CIEM_USER,
      { timeout: 20_000 }
    );

    if (!userFilled) {
      await saveDebugSnapshot(page, outDir, 'debug-login-user-not-found');
      throw new Error('Não encontrei o campo de Usuário (nenhum seletor bateu).');
    }

    // Preenche Senha externa (fallbacks)
    const passFilled = await fillFirstThatExists(
      [
        page.getByLabel(/Senha externa/i),
        page.getByLabel(/Senha/i),
        page.getByPlaceholder(/Senha/i),
        page.locator('input[aria-label*="Senha" i]'),
        page.locator('input[name="senha"]'),
        page.locator('input[name="password"]'),
        page.locator('input[id="senha"]'),
        page.locator('input[id="password"]'),
        page.locator('form input[type="password"]:visible'),
      ],
      CIEM_PASS,
      { timeout: 20_000 }
    );

    if (!passFilled) {
      await saveDebugSnapshot(page, outDir, 'debug-login-pass-not-found');
      throw new Error('Não encontrei o campo de Senha (nenhum seletor bateu).');
    }

    // Entrar (link/botão)
    const clickedEntrar = await clickFirstThatExists(
      [
        page.getByRole('link', { name: /Entrar/i }),
        page.getByRole('button', { name: /Entrar/i }),
        page.locator('a:has-text("Entrar")'),
        page.locator('button:has-text("Entrar")'),
        page.locator('input[type="submit"][value*="Entrar" i]'),
      ],
      { timeout: 60_000 }
    );

    if (!clickedEntrar) {
      await saveDebugSnapshot(page, outDir, 'debug-login-entrar-not-found');
      throw new Error('Não encontrei o "Entrar" (link/botão).');
    }

    // Pós-login
    await page.waitForLoadState('networkidle', { timeout: 120_000 });

    // Menu (se existir)
    await clickFirstThatExists(
      [
        page.getByRole('button', { name: /menu/i }),
        page.getByLabel(/menu/i),
        page.locator('[aria-label*="menu" i]'),
        page.locator('button:has-text("Menu")'),
      ],
      { timeout: 20_000 }
    );

    // Visão serviço
    await page.getByRole('link', { name: /visão serviço/i }).click({ timeout: 60_000 });

    // Espera “15s” do seu procedimento
    await page.waitForTimeout(15_000);

    // Screenshot 1
    await page.screenshot({ path: screenshotVisao, fullPage: true });

    // Monitoramento (nova janela)
    const [monitorPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 60_000 }),
      page.getByRole('link', { name: /Monitoramento/i }).click({ timeout: 60_000 }),
    ]);

    await monitorPage.waitForLoadState('domcontentloaded', { timeout: 120_000 });
    await monitorPage.waitForTimeout(3_000);

    // Screenshot 2
    await monitorPage.screenshot({ path: screenshotMon, fullPage: true });

    // Email
    const subject = `Relatório CIEMSub - ${new Date().toLocaleString('pt-BR')}`;
    const text = `Segue o relatório CIEMSub.\n\nAnexos:\n- visão serviço\n- monitoramento\n`;

    await sendEmailWithAttachments({
      subject,
      text,
      attachments: [screenshotVisao, screenshotMon],
    });
  } catch (err) {
    // Debug final (se algo estourar fora do login)
    await saveDebugSnapshot(page, outDir, 'debug-failure');
    throw err;
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
