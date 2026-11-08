import { ctx } from '../core/context.js';
import { settings } from '../core/settings.js';
import { events } from '../core/events.js';

const NPC_LINES = {
  de: [
    'Na, dann mal los.',
    'Ganz schön was los heute.',
    'Entschuldigung, ich muss weiter.',
    'Hast du die Bahn gesehen?',
    'Das Wetter kann sich auch nicht entscheiden.',
    'Pass ein bisschen auf!',
    'Frankfurt schläft wohl nie.',
    'Ich bin gleich da.',
    'Alles in Ordnung bei dir?',
    'Immer diese Autos auf dem Gehweg.',
    'Schönen Tag noch!',
    'Wo geht’s hier zum Römer?',
  ],
  en: [
    'Busy day, huh?',
    'Excuse me, coming through.',
    'Frankfurt is beautiful today.',
    'Careful there!',
  ],
  tr: ['Kolay gelsin!', 'Bugün şehir çok kalabalık.', 'Pardon, geçebilir miyim?'],
  it: ['Che bella giornata!', 'Permesso, devo passare.', 'Ci vediamo più tardi!'],
  hr: ['Dobar dan!', 'Danas je velika gužva.', 'Oprostite, mogu li proći?'],
  ro: ['Bună ziua!', 'E multă lume azi.', 'Scuzați-mă, trec și eu.'],
  uk: ['Доброго дня!', 'Сьогодні тут людно.', 'Перепрошую, можна пройти?'],
  pl: ['Dzień dobry!', 'Ale dziś tłoczno.', 'Przepraszam, przejdę.'],
  sr: ['Dobar dan!', 'Danas je velika gužva.', 'Izvinite, mogu li da prođem?'],
  bg: ['Добър ден!', 'Днес е много оживено.', 'Извинете, може ли да мина?'],
  fa: ['سلام، روز خوبی داشته باشید!', 'امروز شهر خیلی شلوغ است.', 'ببخشید، اجازه می‌دهید رد شوم؟'],
  es: ['¡Qué buen día!', 'Hoy hay mucha gente.', 'Perdona, ¿me dejas pasar?'],
  fr: ['Quelle belle journée !', 'Il y a du monde aujourd’hui.', 'Pardon, je peux passer ?'],
  hi: ['नमस्ते!', 'आज शहर में बहुत भीड़ है।', 'माफ़ कीजिए, ज़रा रास्ता देंगे?'],
  ar: ['مرحباً!', 'المدينة مزدحمة اليوم.', 'عذراً، هل تسمح لي بالمرور؟'],
  zh: ['你好！', '今天城里真热闹。', '不好意思，借过一下。'],
  ja: ['こんにちは！', '今日は街がにぎやかですね。', 'すみません、通ります。'],
  pt: ['Bom dia!', 'A cidade está cheia hoje.', 'Com licença, posso passar?'],
  vi: ['Xin chào!', 'Hôm nay thành phố đông quá.', 'Xin lỗi, cho tôi đi qua nhé.'],
  ru: ['Добрый день!', 'Сегодня в городе людно.', 'Извините, можно пройти?'],
};

const PLAYER_LINES = {
  de: ['Au!', 'Hey, pass doch auf!', 'Alles okay.', 'Das hat wehgetan.'],
  en: ['Ow!', 'Watch it!', 'I am okay.', 'That hurt.'],
  tr: ['Ah!', 'Dikkat etsene!', 'İyiyim.'],
  it: ['Ah!', 'Fai attenzione!', 'Sto bene.'],
  hr: ['Auh!', 'Pazi malo!', 'Dobro sam.'],
  ro: ['Au!', 'Ai grijă!', 'Sunt bine.'],
  uk: ['Ой!', 'Обережніше!', 'Я в порядку.'],
  pl: ['Au!', 'Uważaj!', 'Nic mi nie jest.'],
  sr: ['Jao!', 'Pazi malo!', 'Dobro sam.'],
  bg: ['Ох!', 'Внимавай!', 'Добре съм.'],
  fa: ['آخ!', 'مواظب باش!', 'خوبم.'],
  es: ['¡Ay!', '¡Ten cuidado!', 'Estoy bien.'],
  fr: ['Aïe !', 'Fais attention !', 'Ça va.'],
  hi: ['आह!', 'ध्यान से!', 'मैं ठीक हूँ।'],
  ar: ['آه!', 'انتبه!', 'أنا بخير.'],
  zh: ['哎哟！', '小心点！', '我没事。'],
  ja: ['痛っ！', '気をつけて！', '大丈夫。'],
  pt: ['Ai!', 'Cuidado!', 'Estou bem.'],
  vi: ['Ái!', 'Cẩn thận chứ!', 'Tôi ổn.'],
  ru: ['Ай!', 'Осторожнее!', 'Я в порядке.'],
};

// Language variety loosely follows Frankfurt's largest resident nationalities
// (city register, 2025); nationality is only a proxy, never a language census.
// The weights keep German dominant and retain English as a frequent bridge language.
const LANGUAGE_WEIGHTS = [
  ['de', 700], ['en', 120], ['tr', 24.3], ['it', 15.1], ['hr', 14.8], ['hi', 12.3],
  ['ro', 11.3], ['uk', 10.7], ['sr', 9.8], ['pl', 9.4], ['bg', 8.9], ['fa', 8.7],
  ['es', 8.35], ['ar', 6.7], ['zh', 5.9], ['fr', 4.6], ['ru', 4], ['pt', 3.8],
  ['ja', 3.4], ['vi', 2.1],
];

/** Browser-provided voices keep the first dialogue pass asset-free. */
export class VoiceDirector {
  constructor() {
    this.synth = globalThis.speechSynthesis;
    this.available = typeof globalThis.SpeechSynthesisUtterance === 'function' && !!this.synth;
    this.cooldown = 8;
    this.lastSpoke = 0;
    if (!this.available) return;
    events.on('subtitle', ({ text }) => {
      const match = /^(Lena|Passenger):\s*(.+)$/i.exec(text || '');
      if (match)
        this.speak(
          match[2],
          match[1].toLowerCase() === 'lena' ? 'en' : this.chooseLanguage(ctx.player?.position),
          0.82,
        );
    });
    events.on('player:damage', () => {
      if (Math.random() < 0.65) this.playerReaction();
    });
  }

  chooseLanguage(position = null) {
    const district = position && ctx.game?.district(position);
    const localDiversity = ['Bahnhofsviertel', 'Innenstadt'].includes(district) ? 1.4 : 1;
    const weighted = LANGUAGE_WEIGHTS.map(([language, weight]) => [language, weight * (language === 'de' ? 1 : localDiversity)]);
    let roll = Math.random() * weighted.reduce((sum, [, weight]) => sum + weight, 0);
    for (const [language, weight] of weighted) {
      roll -= weight;
      if (roll < 0) return language;
    }
    return 'de';
  }

  choosePlayerLanguage() {
    // The protagonist's language stays consistent with the story; broader
    // multilingual variety belongs to the surrounding crowd.
    return Math.random() < 0.7 ? 'de' : 'en';
  }

  speak(text, language, volume = 0.55) {
    if (!this.available || !text || !settings.get('ambientVolume')) return false;
    const Utterance = globalThis.SpeechSynthesisUtterance;
    const utterance = new Utterance(text);
    const locale = { de: 'de-DE', en: 'en-US', tr: 'tr-TR', it: 'it-IT', hr: 'hr-HR', ro: 'ro-RO', uk: 'uk-UA', pl: 'pl-PL', sr: 'sr-RS', bg: 'bg-BG', fa: 'fa-AF', es: 'es-ES', fr: 'fr-FR', hi: 'hi-IN', ar: 'ar-SA', zh: 'zh-CN', ja: 'ja-JP', pt: 'pt-PT', vi: 'vi-VN', ru: 'ru-RU' }[language] || 'de-DE';
    utterance.lang = locale;
    utterance.rate = language === 'de' ? 0.94 : 0.98;
    utterance.pitch = 0.9 + Math.random() * 0.2;
    utterance.volume = Math.min(1, settings.get('ambientVolume') * settings.get('masterVolume') * volume);
    const voices = this.synth.getVoices();
    const prefix = locale.split('-')[0];
    utterance.voice = voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix) && voice.localService) ||
      voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix)) || null;
    this.synth.cancel();
    this.synth.speak(utterance);
    this.lastSpoke = performance.now() / 1000;
    return true;
  }

  playerReaction() {
    const lang = this.choosePlayerLanguage();
    const lines = PLAYER_LINES[lang];
    this.speak(lines[Math.floor(Math.random() * lines.length)], lang, 0.9);
  }

  update(dt) {
    if (!this.available || ctx.game?.paused || ctx.game?.cutscene) return;
    this.cooldown -= dt;
    if (this.cooldown > 0 || ctx.missions?.active || ctx.player?.dead) return;
    const player = ctx.player;
    const pos = player?.position;
    if (!pos || !ctx.peds?.list?.length) return;
    let nearby = false;
    for (const ped of ctx.peds.list) {
      if (ped.down || ped.flee > 0) continue;
      if (Math.hypot(ped.x - pos.x, ped.z - pos.z) < 8) {
        nearby = true;
        break;
      }
    }
    if (!nearby) return;
    this.cooldown = 17 + Math.random() * 15;
    const lang = this.chooseLanguage(pos);
    const lines = NPC_LINES[lang];
    this.speak(lines[Math.floor(Math.random() * lines.length)], lang, 0.38);
  }

  stop() {
    if (this.available) this.synth.cancel();
  }
}
