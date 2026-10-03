export type VoicePreset = {
  id: string;
  label: string;
  description: string;
  prompt: string;
  ffmpegFilter?: string;
};

// VoiceDesign crée la base vocale.
// Le filtre FFmpeg garantit ensuite les caractéristiques physiques difficiles
// à imposer au modèle seul (pitch grave/aigu, résonance, écho, compression).
export const voicePresets: VoicePreset[] = [
  {
    id: "narrator",
    label: "Narrateur sombre",
    description: "Cinématographique, profond, articulé.",
    prompt: "A deep cinematic adult male narrator voice, calm and authoritative, rich low register, precise diction, natural pacing and subtle dramatic tension. Speak fluent French with very clear articulation.",
    ffmpegFilter: "acompressor=threshold=-20dB:ratio=2:attack=15:release=160,alimiter=limit=0.95"
  },
  {
    id: "demon",
    label: "Démon",
    description: "Très grave, ancien, menaçant.",
    prompt: "A huge elderly male voice, extremely deep bass, very low pitched, massive chest resonance, dark, rough, slow, intimidating and threatening.",
    // 48 kHz -> 36 kHz = pitch fortement abaissé, puis tempo compensé.
    ffmpegFilter: "aresample=48000,asetrate=36000,aresample=48000,atempo=1.333333,acompressor=threshold=-18dB:ratio=3:attack=20:release=180,aecho=0.8:0.55:45:0.22,alimiter=limit=0.95"
  },
  {
    id: "troll",
    label: "Troll",
    description: "Massif, rocailleux, brutal.",
    prompt: "A huge fantasy troll, adult male, rough gravelly voice, massive chest presence, primitive and brutal personality, slow powerful phrasing. Speak fluent French clearly.",
    ffmpegFilter: "aresample=48000,asetrate=40800,aresample=48000,atempo=1.176471,acompressor=threshold=-20dB:ratio=2.5:attack=15:release=160,alimiter=limit=0.95"
  },
  {
    id: "dragon",
    label: "Dragon",
    description: "Colossal, très grave, majestueux.",
    prompt: "A colossal ancient male dragon, dark majestic adult voice, royal authority, slow measured speech, threatening intelligence and subtle growl. Speak fluent French with impeccable diction.",
    ffmpegFilter: "aresample=48000,asetrate=33600,aresample=48000,atempo=1.428571,acompressor=threshold=-18dB:ratio=3.2:attack=22:release=220,aecho=0.8:0.60:65:0.28,alimiter=limit=0.94"
  },
  {
    id: "necromancer",
    label: "Nécromancien",
    description: "Vieux, sombre, cérémoniel.",
    prompt: "An elderly sinister male necromancer, dry raspy voice, ritualistic cadence, restrained menace, breathy and unsettling. Speak elegant fluent French clearly.",
    ffmpegFilter: "aresample=48000,asetrate=43200,aresample=48000,atempo=1.111111,acompressor=threshold=-22dB:ratio=2.2:attack=25:release=220,aecho=0.75:0.35:55:0.16,alimiter=limit=0.95"
  },
  {
    id: "spirit",
    label: "Esprit",
    description: "Éthéré, lointain, spectral.",
    prompt: "An ethereal ghost spirit, soft distant airy voice, melancholic and supernatural, floating delivery, delicate but intelligible. Speak fluent French clearly.",
    ffmpegFilter: "highpass=f=160,aecho=0.65:0.60:90:0.35,aecho=0.55:0.30:170:0.18,alimiter=limit=0.93"
  },
  {
    id: "goblin",
    label: "Gobelin",
    description: "Aigu, nerveux, malicieux.",
    prompt: "A small cunning fantasy goblin, high-pitched scratchy nervous voice, mischievous and greedy, quick expressive rhythm. Speak fluent French with crisp articulation.",
    // Pitch relevé de 20 %, tempo ensuite compensé.
    ffmpegFilter: "aresample=48000,asetrate=57600,aresample=48000,atempo=0.833333,acompressor=threshold=-22dB:ratio=2:attack=8:release=100,alimiter=limit=0.95"
  },
  {
    id: "giant",
    label: "Géant",
    description: "Profond, lent, monumental.",
    prompt: "A gigantic ancient male giant, calm and overwhelmingly powerful, monumental slow delivery, heavy adult voice. Speak fluent French clearly and authoritatively.",
    ffmpegFilter: "aresample=48000,asetrate=38400,aresample=48000,atempo=1.25,acompressor=threshold=-18dB:ratio=2.8:attack=25:release=220,alimiter=limit=0.95"
  },
  {
    id: "wizard",
    label: "Sorcier",
    description: "Ancien, sage, mystérieux.",
    prompt: "A very old fantasy wizard, wise mysterious solemn male voice, textured aged timbre, measured pacing and subtle magical intensity. Speak fluent French with excellent diction.",
    ffmpegFilter: "aresample=48000,asetrate=45600,aresample=48000,atempo=1.052632,acompressor=threshold=-22dB:ratio=1.8:attack=20:release=180,aecho=0.75:0.25:70:0.10,alimiter=limit=0.95"
  },
  {
    id: "robot",
    label: "Entité artificielle",
    description: "Synthétique, froide, non humaine.",
    prompt: "A non-human artificial intelligence voice, precise, controlled, emotionally restrained, unnervingly regular and cold. Speak fluent French with flawless articulation.",
    ffmpegFilter: "highpass=f=120,lowpass=f=8000,acompressor=threshold=-24dB:ratio=3:attack=5:release=80,aecho=0.75:0.20:22:0.08,alimiter=limit=0.95"
  },
  {
    id: "custom",
    label: "Prompt libre",
    description: "VoiceDesign pur, sans effet fantasy automatique.",
    prompt: ""
  }
];

export function getVoicePreset(id?: string): VoicePreset {
  return voicePresets.find(p => p.id === id) ?? voicePresets[0];
}
