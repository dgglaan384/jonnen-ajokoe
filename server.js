'use strict';
/*
 * Jonnen ajokoe - huonepalvelin (lobby)
 *
 * Tehtava on pieni: host ilmoittaa taalla ryhmansa, kaverit nakevat sen listalla ja
 * lahettavat liittymispyynnon. Palvelin VAIN valittaa WebRTC-katteljyn viestit -
 * varsinainen pelidata kulkee sen jalkeen suoraan koneelta koneelle, eika tule
 * enaa tanne lainkaan. Siksi tama parjaa hyvin ilmaisella palvelimella.
 *
 * Ei yhtaan riippuvuutta: pelkka Noden sisaanrakennettu http-moduuli. Ei tietokantaa,
 * kaikki muistissa - jos palvelin kaynnistyy uudestaan, avoimet ryhmat haviavat ja
 * hostit ilmoittavat itsensa uudestaan sykaysviestilla muutaman sekunnin sisalla.
 *
 * Kaynnistys:  node server.js          (portti 8080 tai ymparistomuuttuja PORT)
 */

var http = require('http');
var crypto = require('crypto');

var PORT = process.env.PORT || 8080;
var ROOM_TIMEOUT_MS = 45000;    // ryhma katoaa jos hostilta ei kuulu mitaan
var REQ_TIMEOUT_MS = 90000;     // liittymispyynto vanhenee
var MAX_ROOMS = 300;
var MAX_BODY = 200 * 1024;      // SDP-kuvaus on muutama kilotavu, tama on reilusti yli

var rooms = new Map();          // roomId -> {id, name, seed, token, players, seen, reqs:Map}

function id(n){ return crypto.randomBytes(n || 8).toString('hex'); }
function now(){ return Date.now(); }

function cleanup(){
  var t = now();
  rooms.forEach(function(room, key){
    if(t - room.seen > ROOM_TIMEOUT_MS){ rooms.delete(key); return; }
    room.reqs.forEach(function(req, rk){
      if(t - req.at > REQ_TIMEOUT_MS) room.reqs.delete(rk);
    });
  });
}
setInterval(cleanup, 10000).unref();

function send(res, code, obj){
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function readBody(req){
  return new Promise(function(resolve, reject){
    var chunks = [], total = 0;
    req.on('data', function(c){
      total += c.length;
      if(total > MAX_BODY){ reject(new Error('liian iso')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function(){
      if(!chunks.length) return resolve({});
      try{ resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch(e){ reject(new Error('viallinen JSON')); }
    });
    req.on('error', reject);
  });
}
function str(v, max){ return String(v == null ? '' : v).slice(0, max || 120); }

var server = http.createServer(function(req, res){
  var url = new URL(req.url, 'http://x');
  var path = url.pathname.replace(/\/+$/, '') || '/';

  if(req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  // --- terveystarkistus ja etusivu ---
  if(path === '/' || path === '/health'){
    send(res, 200, {ok:true, palvelu:'Jonnen ajokoe - huonepalvelin', ryhmia:rooms.size});
    return;
  }

  // --- ryhmalista ---
  if(path === '/api/rooms' && req.method === 'GET'){
    cleanup();
    var list = [];
    rooms.forEach(function(room){
      list.push({id:room.id, name:room.name, seed:room.seed, players:room.players,
                 age:Math.round((now()-room.created)/1000)});
    });
    list.sort(function(a,b){ return a.age - b.age; });
    send(res, 200, {ok:true, rooms:list});
    return;
  }

  if(req.method !== 'POST'){
    // vastauksen nouto on GET, koska liittyja vain odottaa
    if(path === '/api/answer' && req.method === 'GET'){
      var rid = str(url.searchParams.get('room'), 40);
      var qid = str(url.searchParams.get('req'), 40);
      var rm = rooms.get(rid);
      if(!rm) { send(res, 404, {ok:false, error:'Ryhmää ei löydy - host on ehkä lopettanut.'}); return; }
      var rq = rm.reqs.get(qid);
      if(!rq) { send(res, 404, {ok:false, error:'Liittymispyyntö vanheni.'}); return; }
      if(!rq.answer){ send(res, 200, {ok:true, pending:true}); return; }
      rm.reqs.delete(qid);
      send(res, 200, {ok:true, answer:rq.answer, hostName:rm.hostName});
      return;
    }
    send(res, 404, {ok:false, error:'tuntematon osoite'});
    return;
  }

  readBody(req).then(function(body){
    // --- host luo ryhman tai pitaa sita yllä ---
    if(path === '/api/host'){
      var token = str(body.token, 40);
      var roomId = str(body.room, 40);
      var room = roomId && rooms.get(roomId);
      if(room && room.token !== token){ send(res, 403, {ok:false, error:'väärä tunnus'}); return; }
      if(!room){
        cleanup();
        if(rooms.size >= MAX_ROOMS){ send(res, 503, {ok:false, error:'palvelin on täynnä, yritä hetken päästä'}); return; }
        room = {
          id: id(6), token: id(10), name: str(body.name, 40) || 'Jonnen kylä',
          hostName: str(body.hostName, 16) || 'Jonne',
          seed: Math.abs(parseInt(body.seed, 10) || 0) || 1,
          players: 1, created: now(), seen: now(), reqs: new Map()
        };
        rooms.set(room.id, room);
      } else {
        room.seen = now();
        room.players = Math.max(1, Math.min(32, parseInt(body.players, 10) || 1));
        if(body.name) room.name = str(body.name, 40);
      }
      send(res, 200, {ok:true, room:room.id, token:room.token, seed:room.seed});
      return;
    }

    // --- host lopettaa ---
    if(path === '/api/close'){
      var cr = rooms.get(str(body.room, 40));
      if(cr && cr.token === str(body.token, 40)) rooms.delete(cr.id);
      send(res, 200, {ok:true});
      return;
    }

    // --- kaveri pyytaa liittya: lahettaa oman tarjouksensa ---
    if(path === '/api/join'){
      var jr = rooms.get(str(body.room, 40));
      if(!jr){ send(res, 404, {ok:false, error:'Ryhmää ei löydy - päivitä lista.'}); return; }
      if(!body.offer){ send(res, 400, {ok:false, error:'tarjous puuttuu'}); return; }
      if(jr.reqs.size > 24){ send(res, 429, {ok:false, error:'liikaa liittymispyyntöjä'}); return; }
      var reqId = id(6);
      jr.reqs.set(reqId, {id:reqId, name:str(body.name, 16) || 'Jonne',
                          offer:str(body.offer, 100000), answer:null, at:now(), taken:false});
      send(res, 200, {ok:true, req:reqId, seed:jr.seed, hostName:jr.hostName});
      return;
    }

    // --- host hakee uudet liittymispyynnot ---
    if(path === '/api/requests'){
      var hr = rooms.get(str(body.room, 40));
      if(!hr){ send(res, 404, {ok:false, error:'ryhmää ei löydy'}); return; }
      if(hr.token !== str(body.token, 40)){ send(res, 403, {ok:false, error:'väärä tunnus'}); return; }
      hr.seen = now();
      if(typeof body.players === 'number') hr.players = Math.max(1, Math.min(32, body.players));
      var out = [];
      hr.reqs.forEach(function(rq){
        if(rq.taken || rq.answer) return;
        rq.taken = true;
        out.push({req:rq.id, name:rq.name, offer:rq.offer});
      });
      send(res, 200, {ok:true, requests:out});
      return;
    }

    // --- host vastaa yhteen pyyntoon ---
    if(path === '/api/answer'){
      var ar = rooms.get(str(body.room, 40));
      if(!ar){ send(res, 404, {ok:false, error:'ryhmää ei löydy'}); return; }
      if(ar.token !== str(body.token, 40)){ send(res, 403, {ok:false, error:'väärä tunnus'}); return; }
      var arq = ar.reqs.get(str(body.req, 40));
      if(!arq){ send(res, 404, {ok:false, error:'pyyntö vanheni'}); return; }
      arq.answer = str(body.answer, 100000);
      ar.seen = now();
      send(res, 200, {ok:true});
      return;
    }

    send(res, 404, {ok:false, error:'tuntematon osoite'});
  }).catch(function(e){
    send(res, 400, {ok:false, error:String(e && e.message || e)});
  });
});

server.listen(PORT, function(){
  console.log('Jonnen ajokoe - huonepalvelin kuuntelee portissa ' + PORT);
});
