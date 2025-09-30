// scrape-snapp.js
// Node 18+
// نیاز به Secrets: WP_URL , WP_USER , WP_APP_PASS

import puppeteer from 'puppeteer';

const TARGET_URL = 'https://snappfood.ir/caffe/menu/%D8%AF%D9%86_%DA%A9%D8%A7%D9%81%D9%87__%D9%81%D8%B1%D8%AF%D9%88%D8%B3%DB%8C_-r-0lq8dj/';

function makeSlug(r){
  const base = `${r.author || 'anon'}-${r.date || ''}-${(r.text||'').slice(0,40)}`.toLowerCase();
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

  // اگر تب «اطلاعات و نظرات» جداست، کلیک کن (selector با متن)
  try {
    // نسخه‌های مختلف UI را پوشش می‌دهیم
    const btn = await page.$x(`//button[contains(., 'اطلاعات و نظرات')] | //a[contains(., 'اطلاعات و نظرات')]`);
    if (btn && btn.length) await btn[0].click();
  } catch(e){ /* ignore */ }

  // اسکرول برای لود lazy
  await page.evaluate(async ()=>{
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    for (let i=0;i<24;i++){ window.scrollBy(0,1400); await sleep(400); }
  });

  const rows = await page.evaluate(()=>{
    const clean = s => (s||'').replace(/\s+/g,' ').trim();
    const isRTL  = s => /[\u0600-\u06FF]/.test(s||'');
    const hasReviewHints = t => /نظر|دیدگاه|امتیاز|ستاره|کیفیت|تجربه|سفارش/i.test(t);

    // کاندیدها
    const candidates = Array.from(document.querySelectorAll(
      '[class*="review"], [class*="Review"], [class*="comment"], [class*="Comment"], article, li, section, div'
    )).filter(el=>{
      const t = clean(el.innerText||'');
      return isRTL(t) && t.length>40 && hasReviewHints(t);
    });

    const seen = new Set();
    const rows = [];

    for (const card of candidates){
      const txt = clean(card.innerText||'');
      const lines = (card.innerText||'').split('\n').map(clean).filter(Boolean);

      // author
      let author = lines[0] || '';
      if (author.length>30){
        const strong = card.querySelector('strong, b, [class*="user"], [class*="author"], [class*="name"]');
        author = strong ? clean(strong.innerText||'') : '';
      }

      // date & rating
      const dateMatch   = txt.match(/\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}|امروز|دیروز|\d+\s*(روز|ساعت|هفته)\s*پیش/);
      const ratingMatch = txt.match(/(\d(?:[\.,]\d)?)\s*\/\s*5|(\d(?:[\.,]\d)?)\s*از\s*5|⭐+|ستاره/);

      // متن نظر
      let text = txt;
      [author, dateMatch?.[0], ratingMatch?.[0]].forEach(k=>{ if(k) text = text.replace(k,''); });
      text = clean(text);

      const key = (author||'') + '|' + (dateMatch?.[0]||'') + '|' + text.slice(0,80);
      if (text && !seen.has(key)){
        seen.add(key);
        rows.push({
          author: author || '',
          date: dateMatch ? dateMatch[0] : '',
          rating: ratingMatch ? ratingMatch[0].toString().replace('از','/').replace('٫','.') : '',
          text
        });
      }
    }

    return rows.slice(0, 300);
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
    const payload = {
      title: `نظر - ${r.author || 'بدون نام'} - ${r.date || 'بدون تاریخ'}`,
      content:
        `<p><strong>امتیاز:</strong> ${r.rating || '-'}</p>` +
        `<p>${(r.text || '').replace(/\n/g, '<br>')}</p>`,
      status: 'draft',
      slug: makeSlug(r)
      // اگر custom post type داری، endpoint را در fetch عوض کن
      // و می‌توانی categories / tags اضافه کنی.
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
      console.log('Created post ID:', data.id);
    }
  }
}

(async ()=>{
  const rows = await scrape();
  console.log('Scraped reviews:', rows.length);
  if (!rows.length) return;

  await pushToWP(rows);
  console.log('Done.');
})();
