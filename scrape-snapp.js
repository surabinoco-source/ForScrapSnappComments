// scrape-snapp.js - no $x, robust modal scraping -> WordPress
import puppeteer from 'puppeteer';

const TARGET_URL = 'https://snappfood.ir/caffe/menu/%D8%AF%D9%86_%DA%A9%D8%A7%D9%81%D9%87__%D9%81%D8%B1%D8%AF%D9%88%D8%B3%DB%8C_-r-0lq8dj/';

function makeSlug(title, author, date, text){
  const base = `${title || 'rv'}-${author || ''}-${date || ''}-${(text||'').slice(0,40)}`.toLowerCase();
  return base
    .replace(/[\s\/\\]+/g,'-')
    .replace(/[^a-z0-9\-\u0600-\u06FF]/g,'')
    .replace(/\-+/g,'-')
    .slice(0,180) || ('rv-' + Date.now());
}

async function clickByInnerText(page, text){
  // در کل صفحه دنبال المنتی می‌گردد که متنش شامل «text» باشد و کلیک می‌کند
  const clicked = await page.evaluate((needle)=>{
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'));
    const target = candidates.find(el => (el.innerText || '').includes(needle));
    if (target && target instanceof HTMLElement){
      target.click();
      return true;
    }
    return false;
  }, text);
  return clicked;
}

async function openComments(page){
  // تلاش برای کلیک روی «اطلاعات و نظرات»
  let ok = await clickByInnerText(page, 'اطلاعات و نظرات');
  if (!ok) {
    // اسکرول کوچیک و دوباره تلاش
    await page.evaluate(()=>window.scrollBy(0, 600));
    ok = await clickByInnerText(page, 'اطلاعات و نظرات');
  }
}

async function waitForCommentsLoaded(page){
  await page.waitForFunction(()=>{
    const dialog = document.querySelector('div[role="dialog"]');
    const item = document.querySelector('[class*="Item__Container"]');
    return !!item || !!(dialog && dialog.querySelector('[class*="Item__Container"]'));
  }, { timeout: 60000 });
}

async function scrollInsideModal(page){
  await page.evaluate(async ()=>{
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    const list = document.querySelector('[class*="Comments__CommentsList"]')
             || document.querySelector('div[role="dialog"]');
    if (list){
      for (let i=0;i<40;i++){ list.scrollBy(0,1200); await sleep(300); }
    } else {
      for (let i=0;i<25;i++){ window.scrollBy(0,1400); await sleep(300); }
    }
  });
}

async function scrape(){
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });

  await openComments(page);
  await waitForCommentsLoaded(page);
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
}

async function pushToWP(rows){
  const base = process.env.WP_URL?.replace(/\/$/, '');
  if (!base) throw new Error('Env WP_URL is missing');
  if (!process.env.WP_USER || !process.env.WP_APP_PASS) throw new Error('Env WP_USER/WP_APP_PASS missing');

  const auth = 'Basic ' + Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASS}`).toString('base64');

  for (const r of rows) {
    const contentLine = `${r.author || 'بدون نام'} – امتیاز: ${r.rating || '-'} – ${r.text || ''} – ${r.date || ''}`;
    const payload = {
      title: r.title || 'بدون برچسب',
      content: `<p>${contentLine.replace(/\n/g,' ')}</p>`,
      status: 'draft',
      slug: makeSlug(r.title, r.author, r.date, r.text)
    };

    const res = await fetch(`${base}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.error('WP error:', res.status, await res.text());
    } else {
      const data = await res.json();
      console.log('Created post ID:', data.id, 'title:', r.title);
    }
  }
}

(async ()=>{
  try{
    const rows = await scrape();
    console.log('Reviews found:', rows.length);
    if (rows.length) await pushToWP(rows);
  }catch(e){
    console.error('FAILED:', e);
    process.exit(1);
  }
})();
