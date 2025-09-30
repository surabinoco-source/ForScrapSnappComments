// scrape-snapp.js — stealth + چند روش کلیک + دیباگ کامل
import puppeteer from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteerExtra.use(StealthPlugin());

const TARGET_URL = 'https://snappfood.ir/caffe/menu/%D8%AF%D9%86_%DA%A9%D8%A7%D9%81%D9%87__%D9%81%D8%B1%D8%AF%D9%88%D8%B3%DB%8C_-r-0lq8dj/';
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function makeSlug(title, author, date, text){
  const base = `${title || 'rv'}-${author || ''}-${date || ''}-${(text||'').slice(0,40)}`.toLowerCase();
  return base.replace(/[\s\/\\]+/g,'-').replace(/[^a-z0-9\-\u0600-\u06FF]/g,'').replace(/\-+/g,'-').slice(0,180) || ('rv-' + Date.now());
}

async function closeOverlays(page){
  await page.evaluate(()=>{
    const texts = ['باشه','قبول','متوجه شدم','بستن','×','انتخاب آدرس','فعلاً نه'];
    const clickable = Array.from(document.querySelectorAll('button,a,[role="button"],[aria-label]'));
    for (const t of texts){
      const el = clickable.find(x => (x.innerText||x.getAttribute('aria-label')||'').includes(t));
      if (el && el instanceof HTMLElement) el.click();
    }
    const x = document.querySelector('[aria-label="Close"],[class*="close"],[class*="Close"]');
    if (x && x instanceof HTMLElement) x.click();
  });
}

async function clickReviews(page){
  // 1) DOM: جست‌وجوی متن و کلیک
  const byText = await page.evaluate(()=>{
    const cs = Array.from(document.querySelectorAll('button,a,[role="button"],div,span'));
    const el = cs.find(e => (e.innerText||'').includes('اطلاعات و نظرات'));
    if (!el) return {ok:false};
    el.scrollIntoView({block:'center'}); (el instanceof HTMLElement) && el.click();
    const r = el.getBoundingClientRect(); return {ok:true, x:r.x + r.width/2, y:r.y + r.height/2};
  });
  if (byText?.ok) { await page.mouse.click(byText.x, byText.y, {delay:30}); return true; }

  // 2) XPath داخل خود صفحه (بدون page.$x)
  const byXPath = await page.evaluate(()=>{
    const xp = document.evaluate("//*[contains(text(),'اطلاعات و نظرات')]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const el = xp.singleNodeValue;
    if (!el) return false;
    if (el instanceof HTMLElement){ el.scrollIntoView({block:'center'}); el.click(); return true; }
    return false;
  });
  if (byXPath) return true;

  // 3) حدسِ موقعیت: روی نوار راست/وسط چند نقطه کلیک می‌کنیم
  const { width, height } = await page.viewport();
  const guess = [[width-180, 300],[width-220, 360],[width/2, 420]];
  for (const [x,y] of guess) { await page.mouse.click(x,y,{delay:20}); await sleep(200); }
  return false;
}

async function waitForCommentsLoaded(page){
  await page.waitForFunction(()=>{
    const dlg = document.querySelector('div[role="dialog"]');
    const item = document.querySelector('[class*="Item__Container"]') || (dlg && dlg.querySelector('[class*="Item__Container"]'));
    const title = (dlg && Array.from(dlg.querySelectorAll('*')).some(x => (x.textContent||'').includes('نظرات کاربران')));
    return !!item || title;
  }, { timeout: 120000 }); // 120s
}

async function scrollInsideModal(page){
  await page.evaluate(async ()=>{
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    const list = document.querySelector('[class*="Comments__CommentsList"]') || document.querySelector('div[role="dialog"]');
    const scroller = list || document.scrollingElement || document.documentElement;
    for (let i=0;i<55;i++){ scroller.scrollBy(0, 1200); await sleep(220); }
  });
}

async function scrape(){
  const browser = await puppeteerExtra.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--lang=fa-IR,fa','--disable-blink-features=AutomationControlled']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8' });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36');

  try{
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(1200);
    await closeOverlays(page);
    await sleep(500);
    await page.evaluate(()=>window.scrollBy(0, 500));
    await closeOverlays(page);

    // تا 5 بار تلاش برای کلیک
    let opened = false;
    for (let i=0;i<5 && !opened;i++){
      opened = await clickReviews(page);
      await sleep(700);
      await closeOverlays(page);
    }

    try{
      await waitForCommentsLoaded(page);
    }catch(e){
      await page.screenshot({ path: 'debug_before_timeout.png', fullPage: true });
      const html = await page.content();
      const fs = await import('node:fs/promises');
      await fs.writeFile('debug_before_timeout.html', html);
      throw e;
    }

    await scrollInsideModal(page);

    const rows = await page.evaluate(()=>{
      const clean = s => (s||'').replace(/\s+/g,' ').trim();
      const scope = document.querySelector('div[role="dialog"]') || document;
      const items = Array.from(scope.querySelectorAll('[class*="Item__Container"]'));
      return items.map(el=>{
        const info   = el.querySelector('[class*="Item__CommentInfo"]');
        const body   = el.querySelector('[class*="Item__CommentContent"]');
        const infoPs = info ? info.querySelectorAll('p') : [];
        const author = clean(infoPs?.[0]?.innerText || '');
        const date   = clean(infoPs?.[1]?.innerText || '');
        const ratingEl = info ? info.querySelector('[class*="Item__Rate"]') : null;
        const rating   = clean(ratingEl ? ratingEl.textContent.replace(/[^\d۰-۹]/g,'') : '');
        const text     = clean(body?.querySelector('p')?.innerText || '');
        const tagPs    = body ? body.querySelectorAll('[class*="Item__CommentTags"] p') : [];
        const tags     = Array.from(tagPs).map(p=>clean(p.innerText)).filter(Boolean);
        const title    = tags.length ? tags.join('، ') : 'بدون برچسب';
        return { title, author, rating, text, date };
      });
    });

    await browser.close();
    return rows;
  }catch(e){
    await page.screenshot({ path: 'debug_unhandled.png', fullPage: true }).catch(()=>{});
    const html = await page.content().catch(()=>null);
    if (html){ const fs = await import('node:fs/promises'); await fs.writeFile('debug_unhandled.html', html).catch(()=>{}); }
    await browser.close();
    throw e;
  }
}

async function pushToWP(rows){
  const base = process.env.WP_URL?.replace(/\/$/, '');
  if (!base) throw new Error('Env WP_URL is missing');
  if (!process.env.WP_USER || !process.env.WP_APP_PASS) throw new Error('Env WP_USER/WP_APP_PASS missing');

  const auth = 'Basic ' + Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASS}`).toString('base64');

  for (const r of rows) {
    const contentLine = `${r.author || 'بدون نام'} – امتیاز: ${r.rating || '-'} – ${r.text || ''} – ${r.date || ''}`;
    const payload = { title: r.title || 'بدون برچسب', content: `<p>${contentLine.replace(/\n/g,' ')}</p>`, status: 'draft', slug: makeSlug(r.title, r.author, r.date, r.text) };
    const res = await fetch(`${base}/wp-json/wp/v2/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': auth }, body: JSON.stringify(payload) });
    if (!res.ok) console.error('WP error:', res.status, await res.text());
    else { const data = await res.json(); console.log('Created post ID:', data.id, 'title:', r.title); }
  }
}

(async () => {
  try{
    const rows = await scrape();
    console.log('Reviews found:', rows.length);
    if (rows.length) await pushToWP(rows);
  }catch(e){
    console.error('FAILED:', e);
    process.exit(1);
  }
})();
