// scrape-snapp.js
// Node 18+
// Secrets لازم: WP_URL , WP_USER , WP_APP_PASS

import puppeteer from 'puppeteer';

const TARGET_URL = 'https://snappfood.ir/caffe/menu/%D8%AF%D9%86_%DA%A9%D8%A7%D9%81%D9%87__%D9%81%D8%B1%D8%AF%D9%88%D8%B3%DB%8C_-r-0lq8dj/';

// تبدیل اعداد فارسی به انگلیسی (برای rating/تاریخ اگر خواستی)
const fa2en = s => (s||'').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));

function makeSlug(title, author, date, text){
  const base = `${title || 'rv'}-${author || ''}-${date || ''}-${(text||'').slice(0,40)}`.toLowerCase();
  return base
    .replace(/[\s\/\\]+/g,'-')
    .replace(/[^a-z0-9\-\u0600-\u06FF]/g,'')
    .replace(/\-+/g,'-')
    .slice(0,180) || ('rv-' + Date.now());
}

async function scrape(){
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // 1) باز کردن پاپ‌آپ «اطلاعات و نظرات»
  try {
    const [btn] = await page.$x(`//button[contains(., 'اطلاعات و نظرات')] | //a[contains(., 'اطلاعات و نظرات')]`);
    if (btn) {
      await btn.click();
    }
  } catch(_) {}
  // صبر تا ظاهر شدن پاپ‌آپ
  await page.waitForSelector('div[role="dialog"], [class*="Comments__"]', { timeout: 15000 }).catch(()=>{});

  // 2) اسکرول داخل لیست نظرات (نه کل صفحه)
  // کانتینر لیست:
  const LIST_SELECTOR = '[class*="Comments__CommentsList"]';
  await page.waitForSelector(LIST_SELECTOR, { timeout: 20000 });

  // اسکرول تدریجی داخل همان کانتینر
  await page.evaluate(async (LIST_SELECTOR)=>{
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    const box = document.querySelector(LIST_SELECTOR);
    if (!box) return;
    for (let i=0;i<25;i++){
      box.scrollBy(0, 1200);
      await sleep(350);
    }
  }, LIST_SELECTOR);

  // 3) استخراج ساختاریافته دقیقا با کلاس‌هایی که دادی
  const rows = await page.evaluate(()=>{
    const clean = s => (s||'').replace(/\s+/g,' ').trim();

    const list = document.querySelector('[class*="Comments__CommentsList"]');
    if (!list) return [];

    const items = Array.from(list.querySelectorAll('[class*="Item__Container"]'));
    const out = [];

    for (const el of items){
      const info   = el.querySelector('[class*="Item__CommentInfo"]');
      const body   = el.querySelector('[class*="Item__CommentContent"]');
      if (!info || !body) continue;

      const author = clean(info.querySelector('p')?.innerText || '');               // اولین <p> در Info اسم کاربر است
      const allInfoPs = info.querySelectorAll('p');
      const date   = clean(allInfoPs?.[1]?.innerText || '');                        // دومین <p> تاریخ
      const rateP  = info.querySelector('[class*="Item__Rate"]');
      const rating = clean(rateP ? rateP.textContent.replace(/[^۰-۹0-9.]/g,'') : ''); // فقط رقم امتیاز

      const text   = clean(body.querySelector('p')?.innerText || '');               // متن نظر

      // تگ‌ها (عنوان پست)
      const tagPs  = body.querySelectorAll('[class*="Item__CommentTags"] p');
      const tags   = Array.from(tagPs).map(p=>clean(p.innerText)).filter(Boolean);
      const title  = tags.length ? tags.join('، ') : 'بدون برچسب';

      out.push({ title, author, rating, text, date });
    }
    return out;
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
    // محتوای پست طبق خواسته تو
    // «اسم کاربر - امتیاز - نظر - تاریخ»
    const contentLine = `${r.author || 'بدون نام'} – امتیاز: ${r.rating || '-'} – ${r.text || ''} – ${r.date || ''}`;

    const payload = {
      title: r.title || 'بدون برچسب',
      content: `<p>${contentLine.replace(/\n/g,' ')}</p>`,
      status: 'draft',
      slug: makeSlug(r.title, r.author, r.date, r.text)
    };

    const res = await fetch(`${base}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('WP error:', res.status, errText);
    } else {
      const data = await res.json();
      console.log('Created post ID:', data.id, 'title:', r.title);
    }
  }
}

(async ()=>{
  const rows = await scrape();
  console.log('Reviews found:', rows.length);
  if (!rows.length) return;
  await pushToWP(rows);
  console.log('Done.');
})();
