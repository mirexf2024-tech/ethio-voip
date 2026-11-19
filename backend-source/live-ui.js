/* Ethio Call Group Live: LiveKit audio-room client */
(function () {
  'use strict';
  var st = { room:null, groupId:0, liveId:0, role:'', participants:[], busy:false, timer:null };
  var overlayId = 'ec-live-overlay';
  var words = {
    om:{brand:w('brand'),host:'Ati hoogganaa jirta',speaker:'Ati dubbataa dha',audience:'Ati dhaggeeffataa jirta',limit:'Dubbataa hanga 8',people:'Namoota room keessa jiran',waiting:'Hirmaattota eegaa jira…',connected:'Room live waliin walqabatte',connecting:'Wal qunnamaa jira…',participants:'hirmaattota',you:'Ati',invite:'Dubbachuuf affeeri',mute:'Sagalee cufi',unmute:'Sagalee bani',listen:'Dhaggeeffannaa qofa',end:'Live nama hundaaf dhaabi',leave:'Room keessaa ba’i',close:'Cufi',permission:'Hayyama microphone Ethio Call’f kenni',ended:'Live kun xumurame',removed:'Live kana keessaa si baasaniiru',speakerNow:'Amma dubbataa taate',micError:'Microphone banachuun hin danda’amne',openGroup:'Jalqaba group bani',notRunning:'Live hin jiru. Admin group gaafadhu.',endConfirm:'Live kana nama hundaaf dhaabuu barbaaddaa?',liveEnded:'Live xumurame'},
    am:{brand:'ETHIO CALL · የቡድን ቀጥታ',host:'እርስዎ አስተናጋጅ ነዎት',speaker:'እርስዎ ተናጋሪ ነዎት',audience:'እርስዎ አድማጭ ነዎት',limit:'እስከ 8 ተናጋሪዎች',people:'በቀጥታ ክፍሉ ያሉ ሰዎች',waiting:'ተሳታፊዎችን በመጠበቅ ላይ…',connected:'ከቀጥታ ክፍሉ ጋር ተገናኝተዋል',connecting:'በመገናኘት ላይ…',participants:'ተሳታፊዎች',you:'እርስዎ',invite:'እንዲናገር ጋብዝ',mute:'ማይክሮፎን ዝጋ',unmute:'ማይክሮፎን ክፈት',listen:'ማዳመጥ ብቻ',end:'ለሁሉም አቁም',leave:'ከክፍሉ ውጣ',close:'ዝጋ',permission:'ለEthio Call የማይክሮፎን ፈቃድ ይስጡ',ended:'ይህ ቀጥታ ስርጭት ተጠናቋል',removed:'ከዚህ ቀጥታ ስርጭት ተወግደዋል',speakerNow:'አሁን ተናጋሪ ሆነዋል',micError:'ማይክሮፎኑን መክፈት አልተቻለም',openGroup:'መጀመሪያ ቡድን ይክፈቱ',notRunning:'ቀጥታ ስርጭት የለም። የቡድኑን አስተዳዳሪ ይጠይቁ።',endConfirm:'ይህን ቀጥታ ስርጭት ለሁሉም ማቆም ይፈልጋሉ?',liveEnded:'ቀጥታ ስርጭቱ ተጠናቋል'},
    en:{brand:w('brand'),host:w('host'),speaker:w('speaker'),audience:w('audience'),limit:'Up to 8 speakers',people:w('people'),waiting:w('waiting'),connected:w('connected'),connecting:w('connecting'),participants:'participants',you:'You',invite:w('invite'),mute:'Mute microphone',unmute:'Unmute microphone',listen:'Listening mode',end:w('end'),leave:w('leave'),close:w('close'),permission:w('permission'),ended:w('ended'),removed:w('removed'),speakerNow:w('speakerNow'),micError:'Could not enable microphone',openGroup:w('openGroup'),notRunning:'No live is running. Ask a group admin to start one.',endConfirm:w('endConfirm'),liveEnded:w('liveEnded')}
  };
  function w(key){var lang=window.S&&S.lang||'en';return (words[lang]&&words[lang][key])||words.en[key]||key;}
  var $id = function(id){ return document.getElementById(id); };
  var escHtml = function(v){ return String(v == null ? '' : v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); };
  function msg(s){ if(typeof toast==='function') toast(s,5000); else alert(s); }
  function groupId(){ return window.S && S.grp ? Number(S.grp.id) : 0; }
  function overlay(){ return $id(overlayId); }
  function host(){ return st.role==='host'; }
  function styles(){
    if($id('ec-live-style')) return;
    var e=document.createElement('style'); e.id='ec-live-style';
    e.textContent='.ec-live-overlay{position:fixed;inset:0;z-index:300;background:linear-gradient(155deg,#071b35,#0d4278 62%,#071b35);color:#fff;display:flex;flex-direction:column;padding:calc(18px + env(safe-area-inset-top)) 16px calc(18px + env(safe-area-inset-bottom));overflow:auto;font-family:system-ui,sans-serif}.ec-live-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.ec-live-head h2{font-size:21px;margin:4px 0}.ec-live-sub,.ec-live-muted{font-size:12px;color:#c8d9ec}.ec-live-stage{margin:24px 0 16px;padding:24px 16px;border:1px solid #ffffff2a;border-radius:22px;background:#ffffff10;text-align:center}.ec-live-mic{width:78px;height:78px;border-radius:50%;display:grid;place-items:center;margin:0 auto 14px;background:linear-gradient(145deg,#ffe69a,#f3c544);color:#092b55;font-size:32px;box-shadow:0 0 0 11px #ffffff0d}.ec-live-roster{display:grid;gap:8px;margin:8px 0 16px}.ec-live-person{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 12px;border-radius:14px;background:#ffffff12;border:1px solid #ffffff18}.ec-live-person small{display:block;color:#c8d9ec}.ec-live-person button,.ec-live-actions button{border:0;border-radius:12px;padding:11px 10px;min-height:42px;font-size:14px;font-weight:700;margin:0}.ec-live-person button{background:#f3c544;color:#092b55;width:auto}.ec-live-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:auto;padding-top:16px}.ec-live-actions .soft{background:#ffffff1b;color:#fff;border:1px solid #ffffff2a}.ec-live-actions .danger{background:#c83e4b;color:#fff}.ec-live-close{width:auto;background:#ffffff18;color:#fff;border:1px solid #ffffff35;padding:8px 12px;font-size:14px}.ec-live-audio{display:none}';
    document.head.appendChild(e);
  }
  function render(note){
    styles();
    var old=overlay(); if(old) old.remove();
    var g=window.S && S.grp ? S.grp : {};
    var rows=st.participants.map(function(p){
      var role=p.role==='host'?w('host'):p.role==='speaker'?w('speaker'):w('audience');
      var self=Number(p.user_id)===Number(S.me && S.me.id);
      var canPromote=host() && p.role==='audience' && !self;
      return '<div class="ec-live-person"><div><b>'+escHtml(p.name||p.phone||('Member '+p.user_id))+'</b><small>'+role+(self?' · '+w('you'):'')+'</small></div>'+(canPromote?'<button onclick="ecPromoteSpeaker('+Number(p.user_id)+')">'+w('invite')+'</button>':'')+'</div>';
    }).join('');
    var root=document.createElement('section'); root.id=overlayId; root.className='ec-live-overlay';
    root.innerHTML='<div class="ec-live-head"><div><div style="font-size:10px;letter-spacing:2px;color:#f3c544;font-weight:800">'+w('brand')+'</div><h2>'+escHtml(g.name||'Live room')+'</h2><div class="ec-live-sub">'+(host()?w('host'):st.role==='speaker'?w('speaker'):w('audience'))+' · '+w('limit')+'</div></div><button class="ec-live-close" onclick="ecCloseLive()">'+w('close')+'</button></div>'+
      '<div class="ec-live-stage"><div class="ec-live-mic">'+(st.role==='audience'?'🎧':'🎙️')+'</div><div style="font-size:18px;font-weight:800">'+escHtml(note||w('connected'))+'</div><div class="ec-live-muted" id="ec-live-count">'+st.participants.length+' '+w('participants')+'</div></div>'+
      '<h3 style="font-size:15px;margin:4px 0 10px">'+w('people')+'</h3><div class="ec-live-roster" id="ec-live-roster">'+(rows||'<div class="ec-live-muted">'+w('waiting')+'</div>')+'</div><div id="ec-live-audio" class="ec-live-audio"></div>'+
      '<div class="ec-live-actions">'+(st.role==='host'||st.role==='speaker'?'<button class="soft" id="ec-live-mic" onclick="ecToggleMic()">🎙️ '+w('mute')+'</button>':'<button class="soft" disabled>🎧 '+w('listen')+'</button>')+
      (host()?'<button class="danger" onclick="ecEndLive()">'+w('end')+'</button>':'<button class="danger" onclick="ecLeaveLive()">'+w('leave')+'</button>')+'</div>';
    document.body.appendChild(root);
  }
  async function sdk(){ return await import('https://cdn.jsdelivr.net/npm/livekit-client@2.15.0/+esm'); }
  async function roster(){
    if(!st.groupId) return;
    var r=await api('/groups/'+st.groupId+'/live/participants');
    if(r && Array.isArray(r.participants)){ st.participants=r.participants; render(); }
  }
  async function connect(payload){
    var kit=await sdk();
    if(st.room){ try{await st.room.disconnect();}catch(e){} }
    var room=new kit.Room({adaptiveStream:true,dynacast:true});
    st.room=room;
    room.on('trackSubscribed',function(track){
      if(track.kind==='audio'){
        var el=track.attach(); el.autoplay=true;
        var box=$id('ec-live-audio'); if(box) box.appendChild(el);
        if(el.play) el.play().catch(function(){});
      }
    });
    room.on('trackUnsubscribed',function(track){ track.detach().forEach(function(el){el.remove();}); });
    room.on('participantConnected',function(){roster();});
    room.on('participantDisconnected',function(){roster();});
    room.on('disconnected',function(){if(st.room===room) st.room=null;});
    await room.connect(payload.livekit_url,payload.token);
    st.role=payload.role; st.liveId=Number(payload.live && payload.live.id)||st.liveId;
    if(st.role==='host'||st.role==='speaker') await room.localParticipant.setMicrophoneEnabled(true);
    render();
    await roster();
  }
  function bindEvents(){
    if(!window.socket) return;
    socket.off('live:ended'); socket.off('live:role-changed'); socket.off('live:removed'); socket.off('live:participants-changed');
    socket.on('live:ended',function(d){if(Number(d.group_id)===st.groupId){cleanup();msg(w('ended'));}});
    socket.on('live:role-changed',async function(d){
      if(Number(d.group_id)!==st.groupId||!st.room) return;
      try{var p=await api('/groups/'+st.groupId+'/live/token','POST',{});if(p.error)throw new Error(p.error);await connect(p);msg(w('speakerNow'));}
      catch(e){msg(e.message||'Could not enable microphone');}
    });
    socket.on('live:removed',function(d){if(Number(d.group_id)===st.groupId){cleanup();msg(w('removed'));}});
    socket.on('live:participants-changed',function(d){if(Number(d.group_id)===st.groupId)roster();});
  }
  async function open(){
    if(st.busy) return;
    var gid=groupId(); if(!gid) return msg(w('openGroup'));
    st.busy=true; st.groupId=gid;
    try{
      var status=await api('/groups/'+gid+'/live');
      if(status.error) throw new Error(status.error);
      var payload;
      if(!status.live) payload=await api('/groups/'+gid+'/live/start','POST',{});
      else payload=await api('/groups/'+gid+'/live/token','POST',{});
      if(payload.error) throw new Error(payload.error);
      st.liveId=Number(payload.live&&payload.live.id)||0; st.role=payload.role;
      render(w('connecting'));
      await connect(payload);
      bindEvents();
      if(st.timer) clearInterval(st.timer);
      st.timer=setInterval(roster,12000);
    }catch(e){cleanup();msg(e.message||'Unable to join Group Live');}
    finally{st.busy=false;}
  }
  async function toggleMic(){
    if(!st.room) return;
    try{
      var on=!st.room.localParticipant.isMicrophoneEnabled;
      await st.room.localParticipant.setMicrophoneEnabled(on);
      var b=$id('ec-live-mic'); if(b) b.textContent=on?'🎙️ '+w('mute'):'🔇 '+w('unmute');
    }catch(e){msg(w('permission'));}
  }
  async function promote(uid){
    var r=await api('/groups/'+st.groupId+'/live/promote','POST',{user_id:uid});
    if(!r||r.error) return msg(r&&r.error||'Could not invite speaker');
    await roster();
  }
  function cleanup(){
    if(st.timer){clearInterval(st.timer);st.timer=null;}
    if(st.room){try{st.room.disconnect();}catch(e){}st.room=null;}
    var o=overlay();if(o)o.remove();
    st.role='';st.liveId=0;st.participants=[];
  }
  async function leave(){
    var gid=st.groupId;
    if(host()) return end();
    cleanup();
    if(gid) await api('/groups/'+gid+'/live/leave','POST',{});
    st.groupId=0;
  }
  async function end(){
    if(!host()||!confirm(w('endConfirm'))) return;
    var gid=st.groupId;
    var r=await api('/groups/'+gid+'/live/end','POST',{});
    if(r&&r.error) return msg(r.error);
    cleanup();st.groupId=0;msg(w('liveEnded'));
  }
  function close(){ if(host()) return end(); return leave(); }
  window.openGroupLive=open;
  window.ecToggleMic=toggleMic;
  window.ecPromoteSpeaker=promote;
  window.ecLeaveLive=leave;
  window.ecEndLive=end;
  window.ecCloseLive=close;
  var oldBack=window.handleAppBack;
  if(typeof oldBack==='function') window.handleAppBack=function(){if(overlay()){close();return true;}return oldBack();};
})();
