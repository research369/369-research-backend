#!/usr/bin/env python3
"""Local synthetic UI acceptance. Commerce POST requests always reach real local gateway/PG."""
import json, os, re, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE=Path(__file__).resolve().parents[2]
OUT=BASE/'browser-acceptance'; OUT.mkdir(exist_ok=True)
ORIGIN=os.environ['GATEWAY_ORIGIN'].rstrip('/')
if urllib.parse.urlsplit(ORIGIN).hostname!='127.0.0.1': raise RuntimeError('Loopback required')
snapshot=json.loads((BASE/'frontend/docs/catalog-preview-evidence-20261125/catalog-snapshot.json').read_text())
products=[dict(p) for p in snapshot['products']]
for p in products:
    if p['shopProductId']=='adamax':
        p.update(price=20,salePrice=None,stock=20,inStock=True,variants=[{'dosage':'10 mg','label':'10 mg','price':20,'stock':20,'inStock':True,'sku':'SYNTHETIC-ADAMAX-10MG'}])
stock=[{'shopProductId':'adamax','name':'Adamax (10 mg)','stock':20,'inStock':True,'inventorySku':'SYNTHETIC-ADAMAX-10MG'}, {'shopProductId':'bac-wasser','name':'BAC Wasser 10ml','stock':20,'inStock':True,'inventorySku':'BAC-10ML'}, {'shopProductId':'bac-wasser-3ml','name':'BAC Wasser 3ml','stock':20,'inStock':True,'inventorySku':'BAC-3ML'}]
reads={'article.shopProducts':products,'article.shopAvailability':stock,'article.shopSubstitutionMap':{},'shopSettings.getShopStatus':{'shopOpen':True},'shopSettings.getGlobalAutomaticDiscount':{'discount':None},'shopSettings.getPromo2for3':{'enabled':False,'expiresAt':None,'remainingSeconds':None,'mode':'all','products':[]},'shopSettings.getBankTransferPresentation':{'presentation':{'enabled':True,'accountCount':1,'checkoutLabelDe':'Synthetischer Zahlungsweg – nur Test','checkoutLabelEn':'Synthetic test only','checkoutHintDe':'Keine echte Zahlung ausführen.','checkoutHintEn':'No real payment.'}}}
cart=[{'id':'adamax','name':'Adamax [DIY Nasenspray-Set]','dosage':'10 mg','price':27,'quantity':1,'image':'/products/adamax.png','type':'peptide','isNasalDiySet':True,'isNasalSpray':True,'isPlugPlay':False}]
state={'checks':[],'pageErrors':[],'externalBlocked':0,'commerceCalls':[],'passed':False}
def check(value,label):
    if not value: raise AssertionError(label)
    state['checks'].append(label)
def wire(route,value): route.fulfill(status=200,content_type='application/json',body=json.dumps({'result':{'data':{'json':value}}}))
try:
  with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'])
    for mobile in (False,True):
      label='mobile-lost-response-refresh' if mobile else 'desktop'
      loss={'createDropped':False,'blockReceipt':mobile}
      ctx=browser.new_context(viewport={'width':390 if mobile else 1440,'height':844 if mobile else 1000},service_workers='block')
      ctx.add_init_script("localStorage.setItem('369-age-research-confirmed','true');localStorage.setItem('369-essential-storage-notice-v1','acknowledged'); if (!sessionStorage.getItem('precision-ui-seeded')) {localStorage.setItem('369-cart',"+json.dumps(json.dumps(cart))+ ");sessionStorage.setItem('precision-ui-seeded','1');}")
      def route_request(route):
        req=route.request; url=urllib.parse.urlsplit(req.url)
        if url.path.startswith('/api/precision-commerce/'):
          check(url.hostname=='127.0.0.1','commerce same-origin loopback '+label)
          procedure=url.path.rsplit('/',1)[-1]
          state['commerceCalls'].append({'case':label,'procedure':procedure,'method':req.method})
          check(req.method=='POST','agreed POST method '+procedure+' '+label)
          if mobile and procedure=='order.create' and not loss['createDropped']:
            actual=route.fetch(); check(actual.status==200,'actual create committed before dropped response '+label)
            loss['createDropped']=True; route.abort('failed'); return
          if procedure=='order.checkoutReceipt' and loss['blockReceipt']:
            route.abort('failed'); return
          route.continue_(); return
        if url.path.startswith('/api/trpc/'):
          procedure=url.path.rsplit('/',1)[-1]
          if procedure in reads: wire(route,reads[procedure]); return
          if procedure=='addressValidation.validate': wire(route,{'applicable':False,'status':'valid','warnings':[],'provider':None,'checkedAt':'2026-11-27T00:00:00Z','details':{}}); return
          if procedure=='customerDataChange.preview': wire(route,{'required':False,'changes':[]}); return
          if procedure=='article.shopArticle':
            raw=json.loads(urllib.parse.parse_qs(url.query).get('input',['{}'])[0]).get('json',{})
            wire(route,next((p for p in products if p['shopProductId']==raw.get('shopProductId')),None)); return
          if procedure=='article.shopArticleTranslations': wire(route,{'translations':[],'faqs':[]}); return
          if req.method!='GET': route.abort(); return
          wire(route,None); return
        if url.hostname=='127.0.0.1' and req.method=='GET': route.continue_(); return
        state['externalBlocked']+=1; route.abort()
      ctx.route('**/*',route_request)
      page=ctx.new_page(); page.on('pageerror',lambda error:state['pageErrors'].append(str(error)))
      page.goto(ORIGIN+'/checkout'); page.get_by_placeholder('Max',exact=True).wait_for()
      check(page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),'checkout no horizontal overflow '+label)
      page.get_by_placeholder('Max',exact=True).fill('Synthetic')
      page.get_by_placeholder('Mustermann').fill('Owner')
      page.get_by_placeholder('max@beispiel.de').fill('synthetic@example.test')
      page.get_by_placeholder('+49 151 12345678').fill('+41790000000')
      page.get_by_placeholder('Musterstraße').fill('Local')
      page.get_by_placeholder('12a',exact=True).fill('1')
      page.get_by_placeholder('10115').fill('8000')
      page.get_by_placeholder('Berlin').fill('Local')
      page.locator('select').select_option(label='Schweiz')
      for title in ['Ausschließlich für Forschungszwecke','Altersbestätigung (18+)','Widerrufsrecht','Lieferadresse korrekt']:
        page.locator('label').filter(has_text=title).click()
      submit=page.get_by_role('button',name='Kostenpflichtig bestellen',exact=True)
      submit.wait_for(); page.wait_for_function("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Kostenpflichtig bestellen' && !b.disabled)",timeout=20000)
      check('DIY Nasenspray-Set enthalten' in page.inner_text('body'),'confirmed set contents retained '+label)
      page.screenshot(path=str(OUT/(label+'-checkout.png')),full_page=True)
      submit.click(); page.get_by_role('button',name='Ja, verbindlich bestellen',exact=True).click()
      if mobile:
        page.get_by_role('button',name='Bestellstatus prüfen',exact=True).wait_for(timeout=15000)
        for _ in range(100):
          if loss['createDropped']: break
          page.wait_for_timeout(100)
        check(loss['createDropped'],'real create response lost '+label)
        pending=page.evaluate("JSON.parse(sessionStorage.getItem('369-checkout-intent-v1') || 'null')")
        check(pending and pending.get('uncertain') is True,'uncertain intent durably stored '+label)
        check(page.get_by_role('button',name='Kostenpflichtig bestellen',exact=True).is_disabled(),'unknown outcome blocks duplicate order '+label)
        loss['blockReceipt']=False; page.reload()
      page.wait_for_url('**/order-confirmation*',timeout=20000)
      page.wait_for_function("document.body.innerText.includes('Bestellnummer') || document.body.innerText.includes('Bitte nicht erneut bestellen')",timeout=15000)
      check(page.evaluate("JSON.parse(localStorage.getItem('369-cart') || '[]').length") == 0,'cart cleared only after committed receipt '+label)
      check('/order-confirmation' in page.url,'actual committed receipt opens confirmation '+label)
      check('Bitte nicht erneut bestellen' in page.inner_text('body') or 'Bestellnummer' in page.inner_text('body'),'confirmation shows persisted reference or safe payment recovery '+label)
      check(page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),'confirmation no horizontal overflow '+label)
      page.screenshot(path=str(OUT/(label+'-confirmation.png')),full_page=True)
      check(len([c for c in state['commerceCalls'] if c['case']==label and c['procedure']=='order.create'])==1,'one create request despite reload '+label)
      ctx.close()
    browser.close()
  check(not state['pageErrors'],'no uncaught browser errors')
  state['passed']=True
except Exception as error:
  state['failure']=str(error)
finally:
  (OUT/'result.json').write_text(json.dumps(state,ensure_ascii=False,indent=2)+'\n')
  print(json.dumps(state,ensure_ascii=False,indent=2),flush=True)
if not state['passed']: raise SystemExit(1)
