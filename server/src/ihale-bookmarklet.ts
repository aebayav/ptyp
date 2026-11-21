// İhale bookmarklet üreticisi — kullanıcının GERÇEK tarayıcı oturumunda
// (Cloudflare'in zaten güvendiği istemci) EKAP arama sayfası bağlamında koşan
// tek tıklamalık hasat kodu. Pivot gerekçesi: Turnstile her otomasyon
// tarayıcısını reddediyor (spec REVİZYON A — 21.11.2026 kanıt matrixi).
//
// Üretilen kod yalnız `fetch` ve `alert` serbest değişkenlerini kullanır —
// testler bu yüzden sandbox'ta koşabilir. Tarih penceresi KOŞU ANINDA
// hesaplanır: bookmarklet yeniden kopyalanmadan her gün çalışır.

export const EKAP_SEARCH_URL = 'https://ekapv2.kik.gov.tr/ekap/search';

export interface BookmarkletInput {
  /** PTYP kökü — örn. https://turguz.app (ingest ucu buna yazılır) */
  origin: string;
  /** ihale_settings.ingest_token — uzun ömürlü, JWT değil */
  token: string;
  /** Aktif izleme sorguları — gövdeye gömülür; değişirse yeniden üretilir */
  queries: { name: string; search_text: string }[];
}

// Türkiye 2016'dan beri yaz saati uygulamıyor → yıl boyu UTC+03.
// EKAP pencere kararı (spec): ihale (teslim/açılış) tarihi bugünden İLERİ.
const TR_OFFSET_MS = 3 * 60 * 60 * 1000;

function bookmarkletCode(input: BookmarkletInput): string {
  const ingestUrl = JSON.stringify(String(input.origin).replace(/\/$/, '') + '/api/ihaleler/ingest');
  const token = JSON.stringify(input.token);
  const queries = JSON.stringify(input.queries.map((q) => ({ search_text: q.search_text })));
  return (
    `(async()=>{` +
    `const B=${ingestUrl},T=${token},Q=${queries};` +
    // Koşu anında bugünün Europe/Istanbul 00:00'ı — üretim anı sabitlenmez
    `const D=new Date(Date.now()+${TR_OFFSET_MS}).toISOString().slice(0,10)+'T00:00:00';` +
    `const all=[];` +
    `for(let qi=0;qi<Q.length;qi++){` +
    `const q=Q[qi];let done=false;` +
    `for(let p=0;p<3&&!done;p++){` +
    `let r;try{r=await fetch('/b_ihalearama/api/Ihale/GetListByParameters',{method:'POST',headers:{'content-type':'application/json',accept:'application/json','api-version':'v1'},body:JSON.stringify({` +
    `searchText:q.search_text,filterType:null,ikNdeAra:false,ihaleAdindaAra:true,ihaleBilgilerindeAra:true,teklifCetvelindeAra:true,searchType:'GirdigimGibi',` +
    `iknYili:null,iknSayi:null,` +
    `ihaleTarihSaatBaslangic:D,ihaleTarihSaatBitis:null,ilanTarihSaatBaslangic:null,ilanTarihSaatBitis:null,` +
    `yasaKapsami4734List:[1],ihaleTuruIdList:[2],` +
    `ihaleUsulIdList:[],ihaleUsulAltIdList:[],ihaleIlIdList:[],ihaleDurumIdList:[],ihaleIlanTuruIdList:[],` +
    `teklifTuruIdList:[],asiriDusukTeklifIdList:[],istisnaMaddeIdList:[],okasBransKodList:[],okasBransAdiList:[],` +
    `eIhale:null,eEksiltmeYapilacakMi:null,ortakAlimMi:null,kismiTeklifMi:null,fiyatDisiUnsurVarmi:null,` +
    `ekonomikVeMaliYeterlilikBelgeleriIsteniyorMu:null,meslekiTeknikYeterlilikBelgeleriIsteniyorMu:null,` +
    `isDeneyimiGosterenBelgelerIsteniyorMu:null,yerliIstekliyeFiyatAvantajiUgulaniyorMu:null,` +
    `yabanciIsteklilereIzinVeriliyorMu:null,alternatifTeklifVerilebilirMi:null,konsorsiyumKatilabilirMi:null,` +
    `altYukleniciCalistirilabilirMi:null,fiyatFarkiVerilecekMi:null,avansVerilecekMi:null,` +
    `cerceveAnlasmaMi:null,personelCalistirilmasinaDayaliMi:null,` +
    `orderBy:'ihaleTarihi',siralamaTipi:'asc',paginationSkip:p*10,paginationTake:10})});` +
    `}catch(e){alert('EKAP\\u2019a erişilemedi (ağ). Sayfayı yenileyip tekrar deneyin.');return;}` +
    `if(!r.ok){alert('EKAP sorgusu başarısız (HTTP '+r.status+'). Sayfayı yenileyip tekrar deneyin — doğrulama oturumu eskimiş olabilir.');return;}` +
    `const d=await r.json();const L=(d&&d.list)||[];all.push(...L);if(L.length<10)done=true;` +
    `}` +
    // Sorgular arası nezaket aralığı
    `if(qi<Q.length-1)await new Promise(s=>setTimeout(s,1000));` +
    `}` +
    `let res;try{res=await fetch(B,{method:'POST',headers:{'content-type':'application/json','x-ptyp-token':T},body:JSON.stringify({rows:all})});}` +
    `catch(e){alert('PTYP\\u2019ye gönderilemedi (ağ). Bağlantınızı kontrol edin.');return;}` +
    `let j=null;try{j=await res.json();}catch(_){/* gövde boş olabilir */}` +
    `if(!res.ok){alert('PTYP kabul etmedi (HTTP '+res.status+').'+(j&&j.error?' '+j.error:''));return;}` +
    `alert('PTYP İhale Kutusu: '+((j&&j.new_count)||0)+' yeni, '+((j&&j.changed_count)||0)+' değişen — güncellendi ✓');` +
    `})()`
  );
}

/** Tarayıcı yer imine eklenebilir `javascript:` URL'i üretir. */
export function generateBookmarklet(input: BookmarkletInput): string {
  return 'javascript:' + encodeURIComponent(bookmarkletCode(input));
}
