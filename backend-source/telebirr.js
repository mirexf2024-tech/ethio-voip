const crypto = require('crypto');

function setupTelebirr(app, { pool, auth, changeCoins, io }) {
  const env = () => ({
    base: process.env.TELEBIRR_MODE === 'uat'
      ? 'https://developerportal.ethiotelebirr.et:38443/apiaccess/payment/gateway'
      : 'https://superapp.ethiomobilemoney.et:38443/apiaccess/payment/gateway',
    fabricKey: process.env.TELEBIRR_FABRIC_APP_KEY,
    appSecret: process.env.TELEBIRR_APP_SECRET,
    merchantAppId: process.env.TELEBIRR_MERCHANT_APP_ID,
    merchantCode: process.env.TELEBIRR_MERCHANT_CODE,
    privateKey: process.env.TELEBIRR_PRIVATE_KEY_PEM,
    publicKey: process.env.TELEBIRR_PUBLIC_KEY_PEM,
    notifyUrl: process.env.TELEBIRR_NOTIFY_URL || 'https://ethio-voip.onrender.com/payments/telebirr/notify',
    redirectUrl: process.env.TELEBIRR_REDIRECT_URL || 'https://ethio-voip.onrender.com/',
    checkoutBase: process.env.TELEBIRR_CHECKOUT_BASE_URL
  });
  const configured = (c) => !!(c.fabricKey && c.appSecret && c.merchantAppId && c.merchantCode && c.privateKey && c.publicKey && c.checkoutBase);
  const nonce = () => crypto.randomBytes(16).toString('hex').toUpperCase();
  const canonical = (obj) => Object.keys(obj).filter(k => obj[k] !== undefined && obj[k] !== null && k !== 'sign' && k !== 'sign_type')
    .sort().map(k => k + '=' + String(obj[k])).join('&');
  const sign = (obj, key) => crypto.sign('sha256', Buffer.from(canonical(obj)), {
    key: key.replace(/\\n/g, '\n'),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32
  }).toString('base64');
  const verify = (obj, key) => {
    const sig = String(obj.sign || '');
    if (!sig || sig.length > 1024) return false;
    return crypto.verify('RSA-SHA256', Buffer.from(canonical(obj)), {
      key: key.replace(/\\n/g, '\n'),
      padding: crypto.constants.RSA_PKCS1_PADDING
    }, Buffer.from(sig, 'base64'));
  };
  async function fabricToken(c) {
    const r = await fetch(c.base + '/payment/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-APP-Key': c.fabricKey },
      body: JSON.stringify({ appSecret: c.appSecret }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.token) throw new Error('Telebirr token request failed: ' + (data.errorMsg || r.status));
    return data.token;
  }
  async function init() {
    await pool.query(`
      create table if not exists telebirr_orders (
        id bigserial primary key,
        purchase_id int not null unique references purchases(id) on delete cascade,
        user_id int not null references users(id) on delete cascade,
        merch_order_id varchar(64) not null unique,
        prepay_id varchar(128),
        payment_order_id varchar(128),
        trans_id varchar(128) unique,
        amount_etb numeric(12,2) not null,
        status text not null default 'pending' check(status in ('pending','paid','failed','expired')),
        callback_payload jsonb,
        created_at timestamptz not null default now(),
        paid_at timestamptz
      );
    `);
  }
  app.get('/payments/telebirr/status', auth, (req,res) => {
    const c=env();
    res.json({enabled:configured(c),mode:process.env.TELEBIRR_MODE==='uat'?'uat':'production'});
  });
  app.post('/wallet/telebirr/order', auth, async (req,res) => {
    const c=env();
    if (!configured(c)) return res.status(503).json({error:'Telebirr merchant integration is not configured yet'});
    let purchaseId, merchOrderId;
    try {
      const pkg=await pool.query('select id,name,coins,price_etb from packages where id=$1',[Number(req.body?.package_id)]);
      if (!pkg.rowCount) return res.status(404).json({error:'Coin package not found'});
      const p=pkg.rows[0];
      merchOrderId='EC'+Date.now().toString()+crypto.randomBytes(5).toString('hex').toUpperCase();
      const ref=merchOrderId;
      const saved=await pool.query(
        "insert into purchases(user_id,package_id,package_name,coins,price_etb,ref,status) values($1,$2,$3,$4,$5,$6,'pending') returning id",
        [req.user.id,p.id,p.name,p.coins,p.price_etb,ref]
      );
      purchaseId=saved.rows[0].id;
      await pool.query(
        'insert into telebirr_orders(purchase_id,user_id,merch_order_id,amount_etb) values($1,$2,$3,$4)',
        [purchaseId,req.user.id,merchOrderId,p.price_etb]
      );
      const token=await fabricToken(c);
      const timestamp=String(Math.floor(Date.now()/1000));
      const biz_content={
        notify_url:c.notifyUrl, appid:c.merchantAppId, merch_code:c.merchantCode,
        merch_order_id:merchOrderId, trade_type:'Checkout',
        title:String(p.name).slice(0,64), total_amount:Number(p.price_etb).toFixed(2),
        trans_currency:'ETB', timeout_express:'120m', business_type:'BuyGoods',
        redirect_url:c.redirectUrl
      };
      const payload={timestamp,nonce_str:nonce(),method:'payment.preorder',version:'1.0',biz_content};
      payload.sign=sign(payload,c.privateKey); payload.sign_type='SHA256WithRSA';
      const response=await fetch(c.base+'/payment/v1/merchant/preOrder',{
        method:'POST',
        headers:{'Content-Type':'application/json','X-APP-Key':c.fabricKey,'Authorization':token.startsWith('Bearer ')?token:'Bearer '+token},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)
      });
      const result=await response.json().catch(()=>({}));
      const prepay=result.biz_content?.prepay_id || result.prepay_id;
      if(!response.ok || !prepay || (result.result && result.result!=='SUCCESS')) {
        await pool.query("update telebirr_orders set status='failed' where purchase_id=$1",[purchaseId]);
        await pool.query("update purchases set status='rejected',decided_at=now() where id=$1 and status='pending'",[purchaseId]);
        return res.status(502).json({error:'Telebirr could not create the payment order',provider_code:result.code||result.errorCode||null});
      }
      const checkoutParams={
        appid:c.merchantAppId,merch_code:c.merchantCode,nonce_str:nonce(),
        prepay_id:String(prepay),timestamp:String(Math.floor(Date.now()/1000))
      };
      const checkoutSign=sign(checkoutParams,c.privateKey);
      const url=new URL(c.checkoutBase);
      Object.entries({...checkoutParams,sign_type:'SHA256WithRSA',sign:checkoutSign,version:'1.0',trade_type:'Checkout'})
        .forEach(([k,v])=>url.searchParams.set(k,v));
      await pool.query('update telebirr_orders set prepay_id=$2 where purchase_id=$1',[purchaseId,String(prepay)]);
      res.status(201).json({ok:true,checkout_url:url.toString(),merchant_order_id:merchOrderId,amount_etb:p.price_etb,coins:p.coins});
    } catch(e) {
      console.error('Telebirr order error:',e.message);
      if(purchaseId) {
        await pool.query("update telebirr_orders set status='failed' where purchase_id=$1 and status='pending'",[purchaseId]).catch(()=>{});
        await pool.query("update purchases set status='rejected',decided_at=now() where id=$1 and status='pending'",[purchaseId]).catch(()=>{});
      }
      res.status(502).json({error:'Could not start Telebirr payment. Try again or use the available manual payment option.'});
    }
  });
  app.post('/payments/telebirr/notify', async (req,res) => {
    const c=env();
    if(!c.publicKey) return res.status(503).send('Payment verification unavailable');
    try {
      const body=req.body||{};
      if(body.sign_type!=='SHA256WithRSA' || !verify(body,c.publicKey)) return res.status(401).send('Invalid payment signature');
      if(body.trade_status!=='Completed' || body.trans_currency!=='ETB') return res.status(200).send('Payment not completed');
      const amount=Number(body.total_amount);
      const order=await pool.query('select t.*,p.coins,p.status as purchase_status from telebirr_orders t join purchases p on p.id=t.purchase_id where t.merch_order_id=$1',[String(body.merch_order_id||'')]);
      if(!order.rowCount) return res.status(404).send('Order not found');
      const o=order.rows[0];
      if(!Number.isFinite(amount)||amount!==Number(o.amount_etb)) return res.status(400).send('Amount mismatch');
      if(o.status==='paid'||o.purchase_status==='approved') return res.status(200).send('SUCCESS');
      if(o.status!=='pending'||o.purchase_status!=='pending') return res.status(409).send('Order is not pending');
      const client=await pool.connect();
      let balance,added;
      try {
        await client.query('begin');
        const locked=await client.query(
          "select p.id,p.user_id,p.coins,p.status,t.id as telebirr_id,t.status as telebirr_status from purchases p join telebirr_orders t on t.purchase_id=p.id where p.id=$1 for update of p,t",
          [o.purchase_id]
        );
        if(!locked.rowCount || locked.rows[0].status!=='pending' || locked.rows[0].telebirr_status!=='pending') {
          await client.query('rollback');
          return res.status(200).send('SUCCESS');
        }
        const row=locked.rows[0];
        const credited=await client.query('update users set coins=coins+$2 where id=$1 returning coins',[row.user_id,row.coins]);
        if(!credited.rowCount) throw new Error('User account missing during payment credit');
        balance=credited.rows[0].coins; added=row.coins;
        await client.query("update purchases set status='approved',decided_at=now() where id=$1",[row.id]);
        await client.query(
          'insert into coin_tx(user_id,amount,balance_after,reason) values($1,$2,$3,$4)',
          [row.user_id,row.coins,balance,'telebirr:'+o.merch_order_id]
        );
        await client.query(
          "update telebirr_orders set status='paid',payment_order_id=$2,trans_id=$3,callback_payload=$4::jsonb,paid_at=now() where id=$1",
          [row.telebirr_id,body.payment_order_id?String(body.payment_order_id):null,body.trans_id?String(body.trans_id):null,JSON.stringify(body)]
        );
        await client.query('commit');
      } catch(err) {
        await client.query('rollback').catch(()=>{});
        throw err;
      } finally { client.release(); }
      io.to('u'+o.user_id).emit('wallet:update',{coins:balance,added});
      res.status(200).send('SUCCESS');
    } catch(e) {
      console.error('Telebirr notify error:',e.message);
      res.status(500).send('Notification processing failed');
    }
  });
  return { init };
}
module.exports = { setupTelebirr };
