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

async function getLoginContext(page) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    // 1) Tentativa direta na página
    const hasTextInputs =
      (await page.locator('input[type="text"]:visible,input:not([type]):visible').count()) > 0;
    const hasPasswordInputs = (await page.locator('input[type="password"]:visible').count()) > 0;

    if (hasTextInputs && hasPasswordInputs) return { kind: 'page', ctx: page };

    // 2) Tentativa em iframes
    for (const frame of page.frames()) {
      try {
        const userCount = await frame
          .locator('input[type="text"]:visible,input:not([type]):visible')
          .count();
        const passCount = await frame.locator('input[type="password"]:visible').count();
        if (userCount > 0 && passCount > 0) return { kind: 'frame', ctx: frame };
      } catch {
        // ignora frames não prontos
      }
    }

    await page.waitForTimeout(500);
  }

  return { kind: 'not_found', ctx: page };
}

async function fillLoginFields(ctx, user, pass) {
  // Usuário: candidates comuns + heurística final
  const userLocators = [
    // por label/placeholder (quando existe)
    ctx.getByLabel?.(/Usuário/i),
    ctx.getByPlaceholder?.(/Usuário/i),

    // por aria
    ctx.locator('input[aria-label*="Usu" i]'),

    // por name/id comuns
    ctx.locator('input[name="usuario"]'),
    ctx.locator('input[id="usuario"]'),
    ctx.locator('input[name="user"]'),
    ctx.locator('input[id="user"]'),
    ctx.locator('input[name="username"]'),
    ctx.locator('input[id="username"]'),
    ctx.locator('input[name="login"]'),
    ctx.locator('input[id="login"]'),

    // heurística: primeiro campo texto do form
    ctx.locator('form input[type="text"]:visible'),
    ctx.locator('form input:not([type]):visible'),

    // fallback geral
    ctx.locator('input[type="text"]:visible'),
    ctx.locator('input:not([type]):visible'),
  ].filter(Boolean);

  let filledUser = false;
  for (const l of userLocators) {
    if (await l.count()) {
      await l.first().fill(user);
      filledUser = true;
      break;
    }
  }

  // Senha: normalmente é input[type=password]
  const passCandidates = [
    ctx.getByLabel?.(/Senha externa/i),
    ctx.getByLabel?.(/Senha/i),
    ctx.getByPlaceholder?.(/Senha/i),
    ctx.locator('input[aria-label*="Senha" i]'),
    ctx.locator('input[name="senha"]'),
    ctx.locator('input[id="senha"]'),
    ctx.locator('input[name="password"]'),
    ctx.locator('input[id="password"]'),
    ctx.locator('form input[type="password"]:visible'),
    ctx.locator('input[type="password"]:visible'),
  ].filter(Boolean);

  let filledPass = false;
  for (const p of passCandidates) {
    if (await p.count()) {
      await p.first().fill(pass);
      filledPass = true;
      break;
    }
  }

  return { filledUser, filledPass };
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

  // valida configs de e-mail cedo
  mustEnv('GMAIL_USER');
  mustEnv('GMAIL_APP_PASSWORD');
  mustEnv('EMAIL_TO');

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
    // 1) Access CIEMSub (página inicial que contém o link "(Legado) Usuário externo")
    await page.goto(CIEM_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });

    // 2) Click '(Legado) Usuário externo'
    await page
      .getByRole('link', { name: /\(Legado\)\s*Usuário externo/i })
      .click({ timeout: 60_000 });

    // Dá tempo para renderizar a tela/iframe de login
    await page.waitForTimeout(1_000);

    // 3-4) Descobre onde o login apareceu (page ou iframe) e preenche usuário/senha
    const loginCtxInfo = await getLoginContext(page);
    if (loginCtxInfo.kind === 'not_found') {
      await saveDebugSnapshot(page, outDir, 'debug-login-context-not-found');
      throw new Error('Campos de login não apareceram após clicar em "(Legado) Usuário externo".');
    }

    const { filledUser, filledPass } = await fillLoginFields(loginCtxInfo.ctx, CIEM_USER, CIEM_PASS);
    if (!filledUser || !filledPass) {
      await saveDebugSnapshot(page, outDir, 'debug-login-fields-not-found');
      throw new Error(`Falha ao localizar campos de login (user=${filledUser}, pass=${filledPass}).`);
    }

    // 5) Entrar (link ou botão)
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

    // 1) Localiza o <li class="treeview"> que contém "Cronograma"
    const cronogramaTree = page.locator('ul.sidebar-menu li.treeview', {
      has: page.locator('span', { hasText: /Cronograma/i }),
    });

    // 2) O toggle real é <a href="#">
    const cronogramaToggle = cronogramaTree.locator('> a[href="#"]').first();

    // 3) Submenu colapsável
    const cronogramaMenu = cronogramaTree.locator('ul.treeview-menu').first();

    // 4) Expande se estiver colapsado
    if (!(await cronogramaMenu.isVisible().catch(() => false))) {
      await cronogramaToggle.scrollIntoViewIfNeeded();
      await cronogramaToggle.click({ timeout: 60_000 });
      await page.waitForTimeout(400);
    }

    // 5) Se ainda estiver hidden, força via DOM (fallback)
    if (!(await cronogramaMenu.isVisible().catch(() => false))) {
      await cronogramaTree.evaluate((li) => {
        li.classList.add('active');
        const menu = li.querySelector('ul.treeview-menu');
        if (menu) menu.style.display = 'block';
      });
      await page.waitForTimeout(200);
    }

    await cronogramaMenu.waitFor({ state: 'visible', timeout: 30_000 });

    // 6) Clica em "Visão Serviço" pelo href (/Scheduler)
    const visaoServico = cronogramaMenu.locator('a[href="/Scheduler"]').first();

    // Valida que está visível (sem esperar estabilidade infinita)
    await visaoServico.waitFor({ state: 'visible', timeout: 15_000 });

    // Clica direto (sem scroll, já que está visível)
    await visaoServico.click({ timeout: 60_000, force: true });

    // 8) Wait loading process (15sec)
    await page.waitForTimeout(15_000);

    // 9) Screenshot
    await page.screenshot({ path: screenshotVisao, fullPage: true });

    // 10) Hit the link "Monitoramento" e aguarda nova janela
    const [monitorPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 60_000 }),
      page.getByRole('link', { name: /Monitoramento/i }).click({ timeout: 60_000 }),
    ]);

    // 11) Wait new window
    await monitorPage.waitForLoadState('domcontentloaded', { timeout: 120_000 });
    await monitorPage.waitForTimeout(3_000);

    // 12) Screenshot monitoramento
    await monitorPage.screenshot({ path: screenshotMon, fullPage: true });

    // 13) Envia e-mail (SMTP)
    const subject = `Relatório CIEMSub - ${new Date().toLocaleString('pt-BR')}`;
    const text = `Segue o relatório CIEMSub.\n\nAnexos:\n- visão serviço\n- monitoramento\n`;

    await sendEmailWithAttachments({
      subject,
      text,
      attachments: [screenshotVisao, screenshotMon],
    });
  } catch (err) {
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
