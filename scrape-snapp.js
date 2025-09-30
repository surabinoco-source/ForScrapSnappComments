import puppeteer from 'puppeteer';
import { google } from 'googleapis';
import fetch from 'node-fetch';

const TARGET_URL = 'https://snappfood.ir/caffe/menu/%D8%AF%D9%86_%DA%A9%D8%A7%D9%81%D9%87__%D9%81%D8%B1%D8%AF%D9%88%D8%B3%DB%8C_-r-0lq8dj/';

async function scrape(){
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // اگر تب "اطلاعات و نظرات" لازم است، اینجا کلیک کن (Selector را در صورت نیاز تغییر بده)
  // await page.click('button:has-text("اطلاعات و نظرات")').catch(()=>{});

  // کمی اسکرول برای لود بیشتر
  await page.evaluate(async ()=>{
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    for (let i=0;i<20;i++){ window.scrollBy(0,1200); await sleep(400); }
  });

  const reviews = await page.evaluate(()=>{
    const clean = s => (s||'').replace(/\s+/g,' ').trim();
    const isRTL  = s => /[\u0600-\u06FF]/.test(s||'');
    const hasReviewHints = t => /نظر|دیدگاه|امتیاز|ستاره|کیفیت|تجربه|سفارش/i.test(t);

    const candidates = Array.from(document.querySelectorAll('[class*="review"], [class*="comment"], article, li, section, div'))
      .filter(el => {
        const t = clean(el.innerText||'');
        return isRTL(t) && t.length>40 && hasReviewHints(t);
      });

    const seen = new Set();
    const rows = [];
    for (const card of candidates){
      const txt = clean(card.innerText||'');
      const lines = (card.innerText||'').split('\n').map(clean).filter(Boolean);
      let author = lines[0]||'';
      if (author.length>30){
        const strong = card.querySelector('strong, b, [class*="user"], [class*="author"], [class*="name"]');
        author = strong ? clean(strong.innerText||'') : '';
      }
      const dateMatch   = txt.match(/\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}|امروز|دیروز|\d+\s*(روز|ساعت|هفته)\s*پیش/);
      const ratingMatch = txt.match(/(\d(?:[\.,]\d)?)\s*\/\s*5|(\d(?:[\.,]\d)?)\s*از\s*5|⭐+|ستاره/);

      let text = txt;
      [author, dateMatch?.[0], ratingMatch?.[0]].forEach(k=>{ if(k) text = text.replace(k,''); });
      text = clean(text);
      const key = author + '|' + (dateMatch?.[0]||'') + '|' + text.slice(0,80);
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
    return rows.slice(0,300);
  });

  await browser.close();
  return reviews;
}

// === گزینه 1: ارسال به Google Sheets ===
async function pushToSheet(rows){
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_B64,'base64').toString('utf8')),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({version:'v4', auth});
  // هدر را یک‌بار دستی در Sheet بگذار: author | date | rating | text
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Sheet1!A:D',
    valueInputOption: 'RAW',
    requestBody: { values: rows.map(r=>[r.author,r.date,r.rating,r.text]) }
  });
}

// === گزینه 2: ارسال مستقیم به وردپرس (هر نظر یک پست پیش‌نویس) ===
async function pushToWP(rows){
  if (!process.env.WP_URL) return;
  for (const r of rows){
    const res = await fetch(`${process.env.WP_URL.replace(/\/$/,'')}/wp-json/wp/v2/posts`,{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASS}`).toString('base64')
      },
      body: JSON.stringify({
        title: `نظر - ${r.author || 'بدون نام'} - ${r.date || 'بدون تاریخ'}`,
        content: `<p><strong>امتیاز:</strong> ${r.rating || '-'}</p><p>${r.text}</p>`,
        status: 'draft'
      })
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('WP error:', t);
    }
  }
}

(async ()=>{
  const rows = await scrape();
  if (!rows.length){ console.log('هیچ نظری پیدا نشد.'); return; }
  if (process.env.SHEET_ID && process.env.GOOGLE_CREDENTIALS_B64) {
    await pushToSheet(rows);
    console.log('Rows appended to Google Sheet:', rows.length);
  }
  if (process.env.WP_URL && process.env.WP_USER && process.env.WP_APP_PASS){
    await pushToWP(rows);
    console.log('Rows posted to WordPress as drafts:', rows.length);
  }
})();
