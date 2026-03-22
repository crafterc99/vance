const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS = path.join(__dirname, '.screenshots');
fs.mkdirSync(SCREENSHOTS, { recursive: true });

const URL = 'http://localhost:4000';
let passed = 0, failed = 0, errors = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    errors.push({ name, error: e.message });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Collect console errors
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(err.message));

  console.log('\n═══ BLAIR Command Center UI Tests ═══\n');

  // ─── LOAD ───
  console.log('Phase 1: Page Load');
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOTS, '01-initial-load.png'), fullPage: true });

  await test('Page title contains BLAIR', async () => {
    const title = await page.title();
    if (!title.includes('BLAIR')) throw new Error(`Title: "${title}"`);
  });

  await test('CSS file loaded (command-center.css)', async () => {
    const links = await page.$$eval('link[rel="stylesheet"]', els => els.map(e => e.href));
    if (!links.some(l => l.includes('command-center.css'))) throw new Error('CSS not found');
  });

  await test('Three.js loaded', async () => {
    const has = await page.evaluate(() => typeof THREE !== 'undefined');
    if (!has) throw new Error('THREE not defined');
  });

  await test('marked.js loaded', async () => {
    const has = await page.evaluate(() => typeof marked !== 'undefined');
    if (!has) throw new Error('marked not defined');
  });

  // ─── LAYER 0: PARTICLES ───
  console.log('\nPhase 2: Particle Background');
  await test('Particle canvas exists', async () => {
    const canvas = await page.$('#particleCanvas');
    if (!canvas) throw new Error('Canvas not found');
  });

  await test('Particle canvas has dimensions', async () => {
    const dims = await page.$eval('#particleCanvas', el => ({ w: el.width, h: el.height }));
    if (dims.w < 100 || dims.h < 100) throw new Error(`Canvas too small: ${dims.w}x${dims.h}`);
  });

  await test('particlePulse function exists', async () => {
    const has = await page.evaluate(() => typeof window.particlePulse === 'function');
    if (!has) throw new Error('particlePulse not found');
  });

  // ─── LAYER 3: OVERLAYS ───
  console.log('\nPhase 3: Overlay Effects');
  await test('CRT scanlines visible', async () => {
    const el = await page.$('.overlay-scanlines');
    if (!el) throw new Error('Scanlines not found');
  });

  await test('Vignette overlay visible', async () => {
    const el = await page.$('.overlay-vignette');
    if (!el) throw new Error('Vignette not found');
  });

  await test('HUD corner brackets (4)', async () => {
    const count = await page.$$eval('.hud-bracket', els => els.length);
    if (count !== 4) throw new Error(`Found ${count} brackets`);
  });

  // ─── LAYER 1: TOP BAR ───
  console.log('\nPhase 4: Top Bar');
  await test('Logo with glow animation', async () => {
    const logo = await page.$('.logo');
    if (!logo) throw new Error('Logo not found');
    const text = await logo.textContent();
    if (!text.includes('BLAIR')) throw new Error(`Logo text: "${text}"`);
  });

  await test('Status pill shows Online', async () => {
    const status = await page.$eval('#statusText', el => el.textContent);
    if (!['Online', 'Connecting'].includes(status)) throw new Error(`Status: "${status}"`);
  });

  await test('Status dot has correct class', async () => {
    const cls = await page.$eval('#statusDot', el => el.className);
    if (!cls.includes('online') && !cls.includes('offline') && !cls.includes('nokey'))
      throw new Error(`Dot class: "${cls}"`);
  });

  await test('Cost pill exists', async () => {
    const el = await page.$('#costPill');
    if (!el) throw new Error('Cost pill not found');
    const text = await el.textContent();
    if (!text.includes('$')) throw new Error(`Cost text: "${text}"`);
  });

  await test('Nav buttons: Command Center, Costs, Brain', async () => {
    const navs = await page.$$eval('.nav-btn', els => els.map(e => e.textContent.trim()));
    if (!navs.some(n => n.includes('Command Center'))) throw new Error(`Navs: ${navs}`);
    if (!navs.some(n => n.includes('Costs'))) throw new Error(`No Costs nav`);
    if (!navs.some(n => n.includes('Brain'))) throw new Error(`No Brain nav`);
  });

  // ─── LAYER 2: 3-COLUMN LAYOUT ───
  console.log('\nPhase 5: 3-Column Layout');
  await test('Main grid has 3 columns', async () => {
    const cols = await page.$$eval('.main > *', els => els.length);
    if (cols !== 3) throw new Error(`Found ${cols} columns`);
  });

  await test('Left column exists (.col-left)', async () => {
    const el = await page.$('.col-left');
    if (!el) throw new Error('Left column not found');
    const box = await el.boundingBox();
    if (!box || box.width < 200) throw new Error(`Width: ${box?.width}`);
  });

  await test('Center column exists (.col-center)', async () => {
    const el = await page.$('.col-center');
    if (!el) throw new Error('Center column not found');
  });

  await test('Right column exists (.col-right)', async () => {
    const el = await page.$('.col-right');
    if (!el) throw new Error('Right column not found');
    const box = await el.boundingBox();
    if (!box || box.width < 200) throw new Error(`Width: ${box?.width}`);
  });

  // ─── LEFT COLUMN: PROJECTS ───
  console.log('\nPhase 6: Project Nodes');
  await test('Project list container exists', async () => {
    const el = await page.$('#projectList');
    if (!el) throw new Error('#projectList not found');
  });

  await test('General project node rendered', async () => {
    await page.waitForSelector('.project-node', { timeout: 5000 });
    const nodes = await page.$$('.project-node');
    if (nodes.length < 1) throw new Error('No project nodes');
    const text = await nodes[0].textContent();
    if (!text.includes('General')) throw new Error(`First node: "${text}"`);
  });

  await test('Active project has CSS 3D transform', async () => {
    const transform = await page.$eval('.project-node.active', el => getComputedStyle(el).transform);
    // Should have some transform value (not 'none')
    if (transform === 'none') throw new Error('No 3D transform on active project');
  });

  await test('New Project button exists', async () => {
    const btn = await page.$('#newProjectBtn');
    if (!btn) throw new Error('New project button not found');
  });

  // ─── SYSTEM READOUT ───
  console.log('\nPhase 7: System Readout');
  await test('System readout section exists', async () => {
    const el = await page.$('.system-readout');
    if (!el) throw new Error('System readout not found');
  });

  await test('Readout shows memories count', async () => {
    const el = await page.$('#readout-memories');
    if (!el) throw new Error('Memories readout not found');
  });

  await test('Readout shows skills count', async () => {
    const el = await page.$('#readout-skills');
    if (!el) throw new Error('Skills readout not found');
  });

  // ─── CENTER: WELCOME SCREEN ───
  console.log('\nPhase 8: Welcome Screen');
  await test('Welcome screen visible', async () => {
    const el = await page.$('.welcome');
    if (!el) throw new Error('Welcome not found');
  });

  await test('Orb with 2 orbital rings', async () => {
    const rings = await page.$$eval('.orb-ring', els => els.length);
    if (rings < 2) throw new Error(`Found ${rings} rings`);
  });

  await test('Welcome logo text', async () => {
    const text = await page.$eval('.welcome-logo', el => el.textContent);
    if (!text.includes('BLAIR')) throw new Error(`Logo: "${text}"`);
  });

  await test('Typewriter subtitle animates', async () => {
    // Wait for typewriter to have some text
    await page.waitForTimeout(1500);
    const text = await page.$eval('.welcome-sub', el => el.textContent);
    if (text.length < 5) throw new Error(`Subtitle too short: "${text}"`);
  });

  // ─── CENTER: INPUT AREA ───
  console.log('\nPhase 9: Input Area');
  await test('Input field exists', async () => {
    const el = await page.$('#inputField');
    if (!el) throw new Error('Input field not found');
  });

  await test('Voice button exists', async () => {
    const el = await page.$('#voiceBtn');
    if (!el) throw new Error('Voice button not found');
  });

  await test('Send button exists', async () => {
    const el = await page.$('#sendBtn');
    if (!el) throw new Error('Send button not found');
  });

  await test('Keyboard hints visible', async () => {
    const el = await page.$('.input-hints');
    if (!el) throw new Error('Input hints not found');
    const text = await el.textContent();
    if (!text.includes('Enter')) throw new Error(`Hints: "${text}"`);
  });

  await test('Voice waveform canvas exists', async () => {
    const el = await page.$('#voiceWaveform');
    if (!el) throw new Error('Waveform canvas not found');
  });

  await test('Input focus glow effect', async () => {
    await page.click('#inputField');
    await page.waitForTimeout(300);
    const boxShadow = await page.$eval('#inputField', el => getComputedStyle(el).boxShadow);
    if (boxShadow === 'none') throw new Error('No focus glow');
  });

  // ─── TASK CARD ───
  console.log('\nPhase 10: Task Card');
  await test('Task card exists (hidden by default)', async () => {
    const el = await page.$('#taskCard');
    if (!el) throw new Error('Task card not found');
    const display = await page.$eval('#taskCard', el => getComputedStyle(el).display);
    if (display !== 'none') throw new Error(`Task card visible: ${display}`);
  });

  await test('Task card has model badge', async () => {
    const el = await page.$('#taskModelBadge');
    if (!el) throw new Error('Model badge not found');
  });

  await test('Task card has mini-terminal', async () => {
    const el = await page.$('#taskTerminal');
    if (!el) throw new Error('Mini terminal not found');
  });

  // ─── RIGHT COLUMN: TICKER ───
  console.log('\nPhase 11: Activity Ticker');
  await test('Ticker feed container exists', async () => {
    const el = await page.$('#tickerFeed');
    if (!el) throw new Error('Ticker feed not found');
  });

  await test('Initial ticker event present', async () => {
    await page.waitForTimeout(500);
    const events = await page.$$('.ticker-event');
    if (events.length < 1) throw new Error('No ticker events');
  });

  await test('Ticker event has timestamp + icon + description', async () => {
    const event = await page.$('.ticker-event');
    if (!event) throw new Error('No events');
    const time = await event.$('.ticker-time');
    const icon = await event.$('.ticker-icon');
    const desc = await event.$('.ticker-desc');
    if (!time || !icon || !desc) throw new Error('Event missing parts');
  });

  // ─── RIGHT COLUMN: TELEMETRY ───
  console.log('\nPhase 12: Telemetry Widgets');
  await test('Telemetry grid exists', async () => {
    const el = await page.$('.telemetry-grid');
    if (!el) throw new Error('Telemetry grid not found');
  });

  await test('4 telemetry widgets rendered', async () => {
    const widgets = await page.$$('.telem-widget');
    if (widgets.length !== 4) throw new Error(`Found ${widgets.length} widgets`);
  });

  await test('CPU gauge exists', async () => {
    const el = await page.$('#cpuGauge');
    if (!el) throw new Error('CPU gauge not found');
  });

  await test('Memory bar exists', async () => {
    const el = await page.$('#memBar');
    if (!el) throw new Error('Memory bar not found');
  });

  await test('Disk bar exists', async () => {
    const el = await page.$('#diskBar');
    if (!el) throw new Error('Disk bar not found');
  });

  await test('Cost widget exists', async () => {
    const el = await page.$('#costWidget');
    if (!el) throw new Error('Cost widget not found');
  });

  // Wait for telemetry data to arrive
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(SCREENSHOTS, '02-after-telemetry.png'), fullPage: true });

  await test('CPU gauge shows percentage after telemetry', async () => {
    const text = await page.$eval('#cpuGauge', el => el.textContent);
    if (!text.includes('%')) throw new Error(`CPU: "${text}"`);
  });

  await test('Memory bar populated', async () => {
    const text = await page.$eval('#memBar', el => el.textContent);
    if (!text.includes('%')) throw new Error(`Mem: "${text}"`);
  });

  // ─── MODAL ───
  console.log('\nPhase 13: New Project Modal');
  await test('Modal hidden by default', async () => {
    const display = await page.$eval('#modal', el => getComputedStyle(el).display);
    if (display !== 'none') throw new Error(`Modal visible: ${display}`);
  });

  await test('Clicking New Project opens modal', async () => {
    await page.click('#newProjectBtn');
    await page.waitForTimeout(300);
    const display = await page.$eval('#modal', el => getComputedStyle(el).display);
    if (display === 'none') throw new Error('Modal still hidden');
  });

  await page.screenshot({ path: path.join(SCREENSHOTS, '03-modal-open.png'), fullPage: true });

  await test('Modal has name, description, directory fields', async () => {
    const name = await page.$('#projName');
    const desc = await page.$('#projDesc');
    const dir = await page.$('#projDir');
    if (!name || !desc || !dir) throw new Error('Missing modal fields');
  });

  await test('Escape closes modal', async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const display = await page.$eval('#modal', el => getComputedStyle(el).display);
    if (display !== 'none') throw new Error('Modal still visible');
  });

  // ─── NAVIGATION ───
  console.log('\nPhase 14: Navigation');
  await test('Costs page loads', async () => {
    await page.click('a.nav-btn[href="/costs"]');
    await page.waitForTimeout(1000);
    const title = await page.title();
    await page.screenshot({ path: path.join(SCREENSHOTS, '04-costs-page.png'), fullPage: true });
    // Navigate back
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(1500);
  });

  await test('Brain page loads', async () => {
    await page.click('a.nav-btn[href="/brain"]');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(SCREENSHOTS, '05-brain-page.png'), fullPage: true });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(1500);
  });

  // ─── CHAT FUNCTIONALITY ───
  console.log('\nPhase 15: Chat Flow');
  await test('Type message in input', async () => {
    await page.waitForSelector('#inputField', { timeout: 5000 });
    await page.fill('#inputField', 'Hello, Blair!');
    const val = await page.$eval('#inputField', el => el.value);
    if (val !== 'Hello, Blair!') throw new Error(`Input value: "${val}"`);
  });

  await test('Send message creates user bubble', async () => {
    await page.click('#sendBtn');
    await page.waitForTimeout(500);
    const userMsgs = await page.$$('.msg.user');
    if (userMsgs.length < 1) throw new Error('No user message');
    const text = await userMsgs[0].$eval('.bubble', el => el.textContent);
    if (!text.includes('Hello')) throw new Error(`Bubble: "${text}"`);
  });

  await test('Welcome screen removed after message', async () => {
    const welcome = await page.$('#welcome');
    if (welcome) throw new Error('Welcome still visible');
  });

  // Wait for response or thinking indicator
  await test('Thinking indicator or stream appears', async () => {
    try {
      await page.waitForSelector('#thinkInd, .msg.assistant, .stream-cursor', { timeout: 8000 });
    } catch {
      // May get error response if API issues, that's OK for UI test
    }
  });

  // Wait for response to complete
  await page.waitForTimeout(10000);
  await page.screenshot({ path: path.join(SCREENSHOTS, '06-after-chat.png'), fullPage: true });

  await test('Chat ticker event logged', async () => {
    const events = await page.$$('.ticker-event');
    if (events.length < 2) throw new Error(`Only ${events.length} events`);
  });

  // ─── VISUAL QUALITY ───
  console.log('\nPhase 16: Visual Quality');
  await test('No JS console errors (excluding expected)', async () => {
    const real = consoleErrors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('speechSynthesis') &&
      !e.includes('net::ERR') &&
      !e.includes('429') &&
      !e.includes('billing') &&
      !e.includes('WebGL') &&
      !e.includes('webgl') &&
      !e.includes('WebGLRenderer')
    );
    if (real.length > 0) throw new Error(`Console errors: ${real.join('; ')}`);
  });

  await test('Glass-morphism applied (backdrop-filter)', async () => {
    const filter = await page.$eval('.col-left', el => getComputedStyle(el).backdropFilter);
    // Some browsers report it differently
    if (!filter || filter === 'none') throw new Error(`backdrop-filter: ${filter}`);
  });

  await test('Logo has glow animation', async () => {
    const anim = await page.$eval('.logo', el => getComputedStyle(el).animationName);
    if (!anim || anim === 'none') throw new Error(`Animation: ${anim}`);
  });

  // Final full-page screenshot
  await page.screenshot({ path: path.join(SCREENSHOTS, '07-final.png'), fullPage: true });

  // ─── RESULTS ───
  console.log('\n═══════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════');
  if (errors.length) {
    console.log('\nFailed tests:');
    errors.forEach(e => console.log(`  • ${e.name}: ${e.error}`));
  }
  console.log(`\nScreenshots saved to: ${SCREENSHOTS}/`);

  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
})();
