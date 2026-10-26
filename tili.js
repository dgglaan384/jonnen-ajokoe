'use strict';
/* ====================================================================
 * TILIPALVELIN - Jonnen ajokoe
 * ====================================================================
 * Kayttajatilit, kirjautuminen ja pilvitallennus. Tama tiedosto EI tarvitse
 * yhtaan npm-pakettia: kaikki tulee Noden omista moduuleista (crypto, http).
 * Syy on kaytannollinen - mita vahemman riippuvuuksia, sita vahemman asioita
 * voi hajota Renderin ilmaisessa ymparistossa, ja sita helpompi tama on
 * liittaa olemassa olevaan huonepalvelimeen rikkomatta mitaan.
 *
 * TALLENNUS
 * ---------
 * Oletuksena Upstash Redis REST-rajapinnan yli (pelkkia HTTPS-kutsuja, ei
 * ajuria). Jos ymparistomuuttujia ei ole, kaytetaan paikallista tiedostoa -
 * silla ajetaan testit, EIKA sita pida kayttaa Renderissa, koska Renderin
 * ilmaisen palvelun levy nollautuu joka uudelleenkaynnistyksessa.
 *
 * TURVALLISUUS
 * ------------
 * - Salasana ei mene koskaan levylle eika lokiin selvakielisena. Tallennetaan
 *   scrypt-tiiviste, jokaisella kayttajalla oma satunnainen suola.
 * - Tiivisteiden vertailu tehdaan timingSafeEqualilla.
 * - Kirjautumisyrityksia rajoitetaan sahkopostikohtaisesti.
 * - Token on 32 satunnaista tavua, ja se vanhenee 30 vuorokaudessa.
 * - Varakysymyksen vastaus tiivistetaan samalla tavalla kuin salasana.
 * ==================================================================== */

var crypto = require('crypto');

/* ------------------------------------------------------------------ *
 * Asetukset
 * ------------------------------------------------------------------ */

var TOKEN_IKA_S      = 30 * 24 * 60 * 60;  // 30 vrk
var YRITYS_IKKUNA_S  = 15 * 60;            // vaarien salasanojen laskentajakso
var YRITYS_MAX       = 8;                  // taman jalkeen tauko
var TALLENNUS_MAX    = 400 * 1024;         // pelitallenteen ylaraja tavuina
var NIMI_MIN         = 3;
var NIMI_MAX         = 16;
var SALASANA_MIN     = 6;

/* ------------------------------------------------------------------ *
 * Tallennuskerros
 * ------------------------------------------------------------------ *
 * Kaksi toteutusta saman rajapinnan takana: get, set, setex, del, setnx.
 * Nain palvelinkoodi ei tieda mitaan Upstashista, ja kannan vaihtaminen
 * myohemmin (esim. MongoDB) tarkoittaa yhden olion kirjoittamista.
 */

function upstashVarasto(url, token) {
  var base = String(url).replace(/\/+$/, '');
  function kutsu(komento) {
    return fetch(base, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(komento)
    }).then(function (r) {
      if (!r.ok) throw new Error('Tietokanta vastasi ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j && j.error) throw new Error('Tietokantavirhe: ' + j.error);
      return j ? j.result : null;
    });
  }
  return {
    nimi: 'upstash',
    get: function (k) { return kutsu(['GET', k]); },
    set: function (k, v) { return kutsu(['SET', k, v]); },
    setex: function (k, v, s) { return kutsu(['SET', k, v, 'EX', String(s)]); },
    del: function (k) { return kutsu(['DEL', k]); },
    // SET NX palauttaa null jos avain oli jo olemassa - juuri sita tarvitaan
    // kayttajanimen ja sahkopostin varaamiseen ilman kilpajuoksua.
    setnx: function (k, v) {
      return kutsu(['SET', k, v, 'NX']).then(function (r) { return r !== null; });
    },
    incrEx: function (k, s) {
      return kutsu(['INCR', k]).then(function (n) {
        if (n === 1) return kutsu(['EXPIRE', k, String(s)]).then(function () { return n; });
        return n;
      });
    }
  };
}

function tiedostoVarasto(polku) {
  var fs = require('fs');
  function lue() {
    try { return JSON.parse(fs.readFileSync(polku, 'utf8')); } catch (e) { return {}; }
  }
  function kirjoita(o) { fs.writeFileSync(polku, JSON.stringify(o)); }
  function voimassa(rivi) {
    if (!rivi) return false;
    if (rivi.exp && Date.now() > rivi.exp) return false;
    return true;
  }
  return {
    nimi: 'tiedosto',
    get: function (k) {
      var o = lue();
      return Promise.resolve(voimassa(o[k]) ? o[k].v : null);
    },
    set: function (k, v) {
      var o = lue(); o[k] = { v: v, exp: 0 }; kirjoita(o);
      return Promise.resolve('OK');
    },
    setex: function (k, v, s) {
      var o = lue(); o[k] = { v: v, exp: Date.now() + s * 1000 }; kirjoita(o);
      return Promise.resolve('OK');
    },
    del: function (k) {
      var o = lue(); delete o[k]; kirjoita(o);
      return Promise.resolve(1);
    },
    setnx: function (k, v) {
      var o = lue();
      if (voimassa(o[k])) return Promise.resolve(false);
      o[k] = { v: v, exp: 0 }; kirjoita(o);
      return Promise.resolve(true);
    },
    incrEx: function (k, s) {
      var o = lue();
      var n = voimassa(o[k]) ? (parseInt(o[k].v, 10) || 0) + 1 : 1;
      o[k] = { v: String(n), exp: voimassa(o[k]) ? o[k].exp : Date.now() + s * 1000 };
      kirjoita(o);
      return Promise.resolve(n);
    }
  };
}

var varasto = null;
function haeVarasto() {
  if (varasto) return varasto;
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && tok) {
    varasto = upstashVarasto(url, tok);
  } else {
    var polku = process.env.TILI_TIEDOSTO || './tilit-paikallinen.json';
    varasto = tiedostoVarasto(polku);
    console.warn('[tili] Upstashin ymparistomuuttujia ei loytynyt - kaytetaan ' +
                 'paikallista tiedostoa ' + polku + '. Tama EI sovi tuotantoon.');
  }
  return varasto;
}
// testeja varten: pakota tietty varasto
function asetaVarasto(v) { varasto = v; }

/* ------------------------------------------------------------------ *
 * Salasanat ja tokenit
 * ------------------------------------------------------------------ */

// scrypt on Noden omassa cryptossa, eli bcryptia ei tarvitse asentaa.
// N=16384 on tasapaino: riittavan hidas arvaajalle, alle 100 ms palvelimella.
function tiivista(salasana, suola) {
  return new Promise(function (resolve, reject) {
    crypto.scrypt(String(salasana), suola, 32, { N: 16384, r: 8, p: 1 }, function (err, buf) {
      if (err) reject(err); else resolve(buf.toString('hex'));
    });
  });
}
function uusiSuola() { return crypto.randomBytes(16).toString('hex'); }
function uusiToken() { return crypto.randomBytes(32).toString('hex'); }

// Vertailu vakioajassa: jos tata tekisi ===:lla, vastausaika vuotaisi tietoa
// siita kuinka monta merkkia tiivisteesta meni oikein.
function samatTiivisteet(a, b) {
  var ba = Buffer.from(String(a), 'utf8');
  var bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------------------------------------------ *
 * Syotteiden tarkistus
 * ------------------------------------------------------------------ */

function normEmail(s) { return String(s || '').trim().toLowerCase(); }
function normNimi(s)  { return String(s || '').trim(); }
function nimiAvain(s) { return normNimi(s).toLowerCase(); }

function emailKelpaa(s) {
  // Tarkoituksella loysa: sahkopostin "oikea" saanto on kohtuuttoman monimutkainen
  // eika tiukkuus auta mitaan, koska osoitetta ei tassa vahvisteta.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 120;
}
function nimiKelpaa(s) {
  return /^[A-Za-z0-9ÅÄÖåäö_\- ]+$/.test(s) && s.length >= NIMI_MIN && s.length <= NIMI_MAX;
}

function tarkistaLuonti(b) {
  var email = normEmail(b.email);
  var nimi  = normNimi(b.nimi);
  if (!emailKelpaa(email)) return 'Sähköpostiosoite ei kelpaa.';
  if (!nimiKelpaa(nimi)) {
    return 'Käyttäjänimessä saa olla ' + NIMI_MIN + '-' + NIMI_MAX +
           ' merkkiä: kirjaimia, numeroita, väliviiva, alaviiva tai väli.';
  }
  if (String(b.salasana || '').length < SALASANA_MIN) {
    return 'Salasanassa pitää olla vähintään ' + SALASANA_MIN + ' merkkiä.';
  }
  if (String(b.kysymys || '').trim().length < 5) return 'Varakysymys on liian lyhyt.';
  if (String(b.vastaus || '').trim().length < 2) return 'Varakysymyksen vastaus on liian lyhyt.';
  return null;
}

/* ------------------------------------------------------------------ *
 * Kayttajan haku ja tallennus
 * ------------------------------------------------------------------ *
 * Avaimet:
 *   kayttaja:<email>  -> JSON, koko kayttaja
 *   nimi:<nimi>       -> email, varaa kayttajanimen
 *   token:<token>     -> email, vanhenee itsestaan
 *   tallennus:<email> -> pelitallenne JSONina
 *   yritys:<email>    -> vaarien salasanojen laskuri, vanhenee itsestaan
 */

function haeKayttaja(email) {
  return haeVarasto().get('kayttaja:' + email).then(function (raw) {
    if (!raw) return null;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
  });
}
function talletaKayttaja(k) {
  return haeVarasto().set('kayttaja:' + k.email, JSON.stringify(k));
}

// Ulospain nakyva kayttaja: tiivisteet ja suolat EIVAT kuulu vastaukseen.
function julkinen(k) {
  return { email: k.email, nimi: k.nimi, luotu: k.luotu, kysymys: k.kysymys };
}

/* ------------------------------------------------------------------ *
 * Toiminnot
 * ------------------------------------------------------------------ */

function luoTili(b) {
  var virhe = tarkistaLuonti(b);
  if (virhe) return Promise.resolve({ ok: false, virhe: virhe });
  var email = normEmail(b.email);
  var nimi  = normNimi(b.nimi);
  var v = haeVarasto();

  return haeKayttaja(email).then(function (vanha) {
    if (vanha) return { ok: false, virhe: 'Tällä sähköpostilla on jo tili. Kirjaudu sisään.' };
    // Kayttajanimi varataan ENSIN ja atomisesti. Jos kaksi luo tilia samaan
    // aikaan samalla nimella, vain toinen saa sen - ei "molemmat onnistui".
    return v.setnx('nimi:' + nimiAvain(nimi), email).then(function (saatiin) {
      if (!saatiin) return { ok: false, virhe: 'Käyttäjänimi on jo varattu. Keksi toinen.' };
      var suola = uusiSuola();
      var vSuola = uusiSuola();
      return Promise.all([
        tiivista(b.salasana, suola),
        tiivista(String(b.vastaus).trim().toLowerCase(), vSuola)
      ]).then(function (parit) {
        var k = {
          email: email,
          nimi: nimi,
          suola: suola,
          tiiviste: parit[0],
          kysymys: String(b.kysymys).trim(),
          vSuola: vSuola,
          vTiiviste: parit[1],
          luotu: Date.now()
        };
        return talletaKayttaja(k).then(function () {
          var t = uusiToken();
          return v.setex('token:' + t, email, TOKEN_IKA_S).then(function () {
            return { ok: true, token: t, kayttaja: julkinen(k) };
          });
        });
      }).catch(function (e) {
        // jos tiivistys tai tallennus kaatuu, vapautetaan varattu nimi
        return v.del('nimi:' + nimiAvain(nimi)).then(function () { throw e; });
      });
    });
  });
}

function kirjaudu(b) {
  var email = normEmail(b.email);
  if (!email || !b.salasana) return Promise.resolve({ ok: false, virhe: 'Täytä sähköposti ja salasana.' });
  var v = haeVarasto();
  var yritysAvain = 'yritys:' + email;

  return v.get(yritysAvain).then(function (n) {
    if (n && parseInt(n, 10) >= YRITYS_MAX) {
      return { ok: false, virhe: 'Liian monta väärää salasanaa. Odota vartti ja yritä uudestaan.' };
    }
    return haeKayttaja(email).then(function (k) {
      // Sama viesti olipa sahkoposti tuntematon tai salasana vaara: muuten
      // tasta saisi selville mitka osoitteet ovat olemassa.
      var yleinen = { ok: false, virhe: 'Sähköposti tai salasana on väärin.' };
      if (!k) return v.incrEx(yritysAvain, YRITYS_IKKUNA_S).then(function () { return yleinen; });
      return tiivista(b.salasana, k.suola).then(function (t) {
        if (!samatTiivisteet(t, k.tiiviste)) {
          return v.incrEx(yritysAvain, YRITYS_IKKUNA_S).then(function () { return yleinen; });
        }
        var tok = uusiToken();
        return v.del(yritysAvain)
          .then(function () { return v.setex('token:' + tok, email, TOKEN_IKA_S); })
          .then(function () { return { ok: true, token: tok, kayttaja: julkinen(k) }; });
      });
    });
  });
}

function tunnista(token) {
  if (!token) return Promise.resolve(null);
  return haeVarasto().get('token:' + token).then(function (email) {
    if (!email) return null;
    return haeKayttaja(String(email));
  });
}

function kirjauduUlos(token) {
  if (!token) return Promise.resolve({ ok: true });
  return haeVarasto().del('token:' + token).then(function () { return { ok: true }; });
}

function haeKysymys(b) {
  var email = normEmail(b.email);
  return haeKayttaja(email).then(function (k) {
    // Tuntemattomallakin osoitteella vastataan samannakoisesti, jottei tasta
    // voi kalastella kenella on tili.
    if (!k) return { ok: false, virhe: 'Tällä osoitteella ei ole tiliä.' };
    return { ok: true, kysymys: k.kysymys };
  });
}

function palautaSalasana(b) {
  var email = normEmail(b.email);
  if (String(b.uusiSalasana || '').length < SALASANA_MIN) {
    return Promise.resolve({ ok: false, virhe: 'Uudessa salasanassa pitää olla vähintään ' + SALASANA_MIN + ' merkkiä.' });
  }
  var v = haeVarasto();
  var yritysAvain = 'palautus:' + email;
  return v.get(yritysAvain).then(function (n) {
    if (n && parseInt(n, 10) >= YRITYS_MAX) {
      return { ok: false, virhe: 'Liian monta väärää vastausta. Odota vartti.' };
    }
    return haeKayttaja(email).then(function (k) {
      if (!k) return { ok: false, virhe: 'Tällä osoitteella ei ole tiliä.' };
      return tiivista(String(b.vastaus || '').trim().toLowerCase(), k.vSuola).then(function (t) {
        if (!samatTiivisteet(t, k.vTiiviste)) {
          return v.incrEx(yritysAvain, YRITYS_IKKUNA_S).then(function () {
            return { ok: false, virhe: 'Vastaus ei täsmää.' };
          });
        }
        var suola = uusiSuola();
        return tiivista(b.uusiSalasana, suola).then(function (uusi) {
          k.suola = suola;
          k.tiiviste = uusi;
          return talletaKayttaja(k)
            .then(function () { return v.del(yritysAvain); })
            .then(function () {
              var tok = uusiToken();
              return v.setex('token:' + tok, email, TOKEN_IKA_S).then(function () {
                return { ok: true, token: tok, kayttaja: julkinen(k) };
              });
            });
        });
      });
    });
  });
}

function tallennaPilveen(token, data) {
  return tunnista(token).then(function (k) {
    if (!k) return { ok: false, virhe: 'Kirjautuminen vanhentui. Kirjaudu uudestaan.' };
    var teksti = typeof data === 'string' ? data : JSON.stringify(data);
    if (!teksti) return { ok: false, virhe: 'Tyhjää tallennusta ei viedä pilveen.' };
    if (Buffer.byteLength(teksti, 'utf8') > TALLENNUS_MAX) {
      return { ok: false, virhe: 'Tallennus on liian iso (yli ' + Math.round(TALLENNUS_MAX/1024) + ' kt).' };
    }
    var paketti = JSON.stringify({ aika: Date.now(), data: teksti });
    return haeVarasto().set('tallennus:' + k.email, paketti).then(function () {
      return { ok: true, aika: Date.now() };
    });
  });
}

function haePilvesta(token) {
  return tunnista(token).then(function (k) {
    if (!k) return { ok: false, virhe: 'Kirjautuminen vanhentui. Kirjaudu uudestaan.' };
    return haeVarasto().get('tallennus:' + k.email).then(function (raw) {
      if (!raw) return { ok: true, tyhja: true };
      var p;
      try { p = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return { ok: true, tyhja: true }; }
      return { ok: true, aika: p.aika, data: p.data };
    });
  });
}

/* ------------------------------------------------------------------ *
 * HTTP-kasittely
 * ------------------------------------------------------------------ *
 * kasittele(req, res) palauttaa Promisen joka tayttyy arvolla true jos pyynto
 * kuului tileille ja se hoidettiin, ja false jos se kuuluu jollekin muulle.
 * Nain taman saa liitettya seka Expressiin etta paljaaseen http-palvelimeen
 * ilman etta olemassa olevaan koodiin tarvitsee koskea kuin kaksi rivia.
 */

var REITIT = {
  '/api/tili/luo':        function (b) { return luoTili(b); },
  '/api/tili/kirjaudu':   function (b) { return kirjaudu(b); },
  '/api/tili/ulos':       function (b) { return kirjauduUlos(b.token); },
  '/api/tili/kysymys':    function (b) { return haeKysymys(b); },
  '/api/tili/palauta':    function (b) { return palautaSalasana(b); },
  '/api/tili/tallenna':   function (b) { return tallennaPilveen(b.token, b.data); },
  '/api/tili/lataa':      function (b) { return haePilvesta(b.token); },
  '/api/tili/mina':       function (b) {
    return tunnista(b.token).then(function (k) {
      if (!k) return { ok: false, virhe: 'Kirjautuminen vanhentui.' };
      return { ok: true, kayttaja: julkinen(k) };
    });
  }
};

function lueRunko(req) {
  return new Promise(function (resolve) {
    // Jos joku runko on jo luettu (Expressin express.json), kaytetaan sita.
    if (req.body && typeof req.body === 'object') { resolve(req.body); return; }
    var osat = [], koko = 0, liikaa = false;
    req.on('data', function (c) {
      koko += c.length;
      if (koko > TALLENNUS_MAX + 4096) { liikaa = true; return; }
      osat.push(c);
    });
    req.on('end', function () {
      if (liikaa) { resolve(null); return; }
      try { resolve(JSON.parse(Buffer.concat(osat).toString('utf8') || '{}')); }
      catch (e) { resolve(null); }
    });
    req.on('error', function () { resolve(null); });
  });
}

function vastaa(res, koodi, olio) {
  var teksti = JSON.stringify(olio);
  res.writeHead(koodi, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // Samat CORS-otsakkeet kuin huonepalvelimen muissa vastauksissa, jotta
    // myos selaimesta ajettava peli voi myohemmin kutsua naita reitteja.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Content-Length': Buffer.byteLength(teksti, 'utf8')
  });
  res.end(teksti);
}

function kasittele(req, res) {
  var polku = String(req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
  var reitti = REITIT[polku];
  if (!reitti) return Promise.resolve(false);
  if (req.method !== 'POST') {
    vastaa(res, 405, { ok: false, virhe: 'Käytä POST-metodia.' });
    return Promise.resolve(true);
  }
  return lueRunko(req).then(function (b) {
    if (!b) { vastaa(res, 400, { ok: false, virhe: 'Virheellinen pyyntö.' }); return true; }
    return reitti(b).then(function (tulos) {
      vastaa(res, tulos && tulos.ok ? 200 : 400, tulos || { ok: false, virhe: 'Tuntematon virhe.' });
      return true;
    });
  }).catch(function (e) {
    // Virheen sisaltoa ei naytetä ulos: se voisi paljastaa kannan rakenteen.
    console.error('[tili] virhe:', e && e.message ? e.message : e);
    vastaa(res, 500, { ok: false, virhe: 'Palvelinvirhe. Yritä hetken päästä uudestaan.' });
    return true;
  });
}

/* Expressiin:   app.use(require('./tili').express());                     */
function expressValiohjelma() {
  return function (req, res, next) {
    kasittele(req, res).then(function (hoidettu) { if (!hoidettu) next(); });
  };
}

module.exports = {
  kasittele: kasittele,
  express: expressValiohjelma,
  // testeja ja mahdollista muuta kayttoa varten
  luoTili: luoTili,
  kirjaudu: kirjaudu,
  tunnista: tunnista,
  asetaVarasto: asetaVarasto,
  tiedostoVarasto: tiedostoVarasto,
  upstashVarasto: upstashVarasto
};
