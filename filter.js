/* Sky Ace – filtro básico de nomes impróprios (PT/EN/ES/FR/DE).
   Partilhado entre a extensão e o servidor. As listas estão em ROT13 só para não ficarem legíveis no código. */
(function (root) {
  'use strict';
  var STRONG = "nefpuybpu nffubyr onfgneq ongneq ovgpu obyybpx ohprgn pnoenb pnoeba pnoeban pnenyub puvatn pbpxfhpxre pbaaneq pbaanffr pbhvyyr phag qvpxurnq raphyr snttbg svyubqnchgn sbqnfr sbgmr shpx tvyvcbyynf uvgyre uherafbua vaprfg wbqre xnanxr znevpba zreqn zreqr zvreqn zbgureshpxre anmv avttn avttre avdhre cnaryrveb crqbsvyb crqbcuvyr craqrwb cbea cbeen chaurgn chffl chgnva ergneq fnybcr fpurvffr fpuynzcr fpujhpugry fuvg fyhg gjng jnaxre juber jvpufre";
  var WEAK = "nany ovgr obdhrgr ohzfra pbpx pban pbab ph phz qvpx snt sqc svpx svpxra sbqn sbqre sbyyne sbhger urvy znevpn artre avdhr ahggr cq crqb cravf cvyn cvapur chgn chgr chgb encr encvfg frk frkb fcnfg gncrggr gvgf intvan iretn ivnqb mbeen";
  var rot = function (s) { return s.replace(/[a-z]/g, function (c) { return String.fromCharCode((c.charCodeAt(0) - 97 + 13) % 26 + 97); }); };
  var LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't' };
  var collapse = function (s) { return s.replace(/(.)\1+/g, '$1'); };
  var strong = rot(STRONG).split(' ').map(collapse);
  var weak = {}; rot(WEAK).split(' ').forEach(function (w) { weak[collapse(w)] = 1; });
  function norm(name) {
    var s = String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');
    return s.replace(/[0134578@$!|+]/g, function (c) { return LEET[c]; });
  }
  function isBad(name) {
    var s = norm(name);
    var squashed = collapse(s.replace(/[^a-z]/g, ''));
    if (weak[squashed]) return true;
    for (var i = 0; i < strong.length; i++) if (squashed.indexOf(strong[i]) !== -1) return true;
    var tokens = s.split(/[^a-z]+/);
    for (var j = 0; j < tokens.length; j++) if (tokens[j] && weak[collapse(tokens[j])]) return true;
    return false;
  }
  var api = { isBad: isBad };
  root.SkyFilter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
