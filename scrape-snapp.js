// scrape-snapp.js — robust: close overlays + coordinate click + screenshot on fail
import puppeteer from 'puppeteer';

const TARGET_URL = 'https://snappfood.ir/caffe/menu/%D8%AF%D9%86_%DA%A9%D8%A7%D9%81%D9%87__%D9%81%D8%B1%D8%AF%D9%88%D8%B3%DB%8C_-r-0lq8dj/';

function makeSlug(title, author, date, text){
  const base = `${title || 'rv'}-${author || ''}-${date || ''}-${(text||'').slice(0,40)}`.toLowerCase();
  return base.replace(/[\s\/\\]+/g,'-').replace(/[^a-z0-9\-\u0600-\u06FF]/g,'').replace(/\-+/g,'-').slice(0,180) || ('rv-' + Date.now());
}

async function closeOverlays(page){
  // چند کلمهٔ رایج روی بنرها/مودال‌ها
  const words = ['باشه','قبول','متوجه شدم','بستن','×','انتخاب آدرس','فعلاً نه'];
  await page.evaluate((labels)=>{
    const clickFirst = (els)=>{ if(els.length) (els[0] instanceof HTMLElement) && els[0].click(); };
    // دکمه‌ها
    const btns = Array.from(document.querySelectorAll('button,a,[role="button"]'));
    for (const w of labels){
      const hit = btns.find(b => (b.innerText||'').trim().includes(w));
      if (hit){ (hit instanceof HTMLElement) && hit.click(); }
    }
    // آیکون ×
    clickFirst(document.querySelectorAll('[aria-label="Close"],[class*="close"],[class*="Close"]'));
  }, words);
}

async function clickReviewsButton(page){
  // پیدا کردن، اسکرول، DOM-click و درصورت نیاز click مختصاتی
  const clicked = await page.evaluate(()=>{
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'));
    const el = candidates.find(e => (e.innerText||'').includes('اطلاعات و نظرات'));
    if (!el) return {ok:false};
    el.scrollIntoView({block:'center'});
    (el instanceof HTMLElement) && el.click();
    const r = el.getBoundingClientRect();
    return {ok:true, rect: {x: r.x + r.width/2, y: r.y + r.height/2}};
  });
  if (!clicked.ok && clicked.rect){
    // هیچ‌کار — بالا DOM کلیک کردیم
  } else if (clicked.ok && clicked.rect){
    // یک کلیک واقعی هم بزنیم که اگر overlay بوده، ردش کند
    const {x,y} = clicked.rect;
    await page.mouse.click(x, y, {delay: 20});
  }
}

async function waitForCommentsLoaded(page){
  await page.waitForFunction(()=>{
    const dlg = document.querySelector('div[role="dialog"]');
    const item = document.querySelector('[class*="Item__Container"]') || (dlg && dlg.querySelector('[class*="Item__Container"]'));
    return !!item;
  }, { timeout: 90000 });
}

async function scrollInsideModal(page){
  await page.evaluate(async ()=>{
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    const list = document.querySelector('[class*="Comments__CommentsList"]') || document.querySelector('div[role="dialog"]');
    const target = list || document.scrollingElement || document.documentElement;
    for (let i=0;i<45;i++){ target.scrollBy(0, 1200); await sleep(250); }
  });
}

async function scrape(){
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

  // کمی صبر و بستن بنرها
  await page.waitForTimeout(1200);
  await closeOverlays(page);
  await page.waitForTimeout(600);

  // اسکرول کوتاه، دوباره بستن بنرهای جدید
  await page.evaluate(()=>window.scrollBy(0, 400));
  await page.waitForTimeout(400);
  await closeOverlays(page);

  // کلیک روی «اطلاعات و نظرات»
  await clickReviewsButton(page);

  // منتظر لود آیتم‌ها؛ اگر نشد، اسکرین‌شات بگیر که دیباگ کنیم
  try{
    await waitForCommentsLoaded(page);
  }catch(e){
    await page.screenshot({ path: 'debug_before_timeout.png', fullPage: true });
    throw e;
  }

  // اسکرول برای لود بیشتر
  await scrollInsideModal(page);

  // استخراج
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
}

async function pushToWP(rows){
  const base = process.env.WP_URL?.replace(/\/$/, '');
  if (!base) throw new Error('Env WP_URL is missing');
  if (!process.env.WP_USER || !process.env.WP_APP_PASS) throw new Error('Env WP_USER/WP_APP_PASS missing');

  const auth = 'Basic ' + Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASS}`).toString('base64');

  for (const r of rows) {
    const contentLine = `${r.author || 'بدون نام'} – امتیاز: ${r.rating || '-'} – ${r.text || ''} – ${r.date || ''}`;
    const payload = { title: r.title || 'بدون برچسب', content: `<p>${contentLine}</p>`, status: 'draft', slug: makeSlug(r.title, r.author, r.date, r.text) };
    const res = await fetch(`${base}/wp-json/wp/v2/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': auth }, body: JSON.stringify(payload) });
    if (!res.ok) console.error('WP error:', res.status, await res.text());
    else { const data = await res.json(); console.log('Created post ID:', data.id, 'title:', r.title); }
  }
}

(async ()=>{
  try{
    const rows = await scrape();
    console.log('Reviews found:', rows.length);
    if (rows.length) await pushToWP(rows);
  }catch(e){
    console.error('FAILED:', e);
    // بگذار اسکرین‌شات در آرتیفکت اکشن آپلود شود
    process.exit(1);
  }
})();
