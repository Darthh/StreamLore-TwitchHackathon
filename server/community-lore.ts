import type { Lore } from '../shared/types.ts';
import { answerLoreQuestion } from '../shared/lore.ts';

// Editorial starter references, never represented as approval by these streamers.
export const communities = [
  {
    channelId: '71092938', login: 'xqc', displayName: 'xQc',
    entries: [{
      id: 'starter-xqc-juicer', term: 'Juicer', aliases: ['juicers'], category: 'Tradition',
      explanation: 'In xQc’s community, a Juicer is a fan or member of his chat. “Juicers” is the collective name for the community.',
      origin: 'The community name comes from xQc’s recurring “juice” vocabulary. This reference explains the community meaning; it does not claim a verified first-use clip.',
      references: [
        { title: 'xQc Twitch profile', url: 'https://www.twitch.tv/xqc/about' },
        { title: 'Community name reference', url: 'https://en.wikipedia.org/wiki/List_of_fandom_names' },
      ],
    }],
  },
  {
    channelId: '92038375', login: 'caedrel', displayName: 'Caedrel',
    entries: [{
      id: 'starter-caedrel-sally', term: 'Sally', aliases: ['sally lamont'], category: 'Character',
      explanation: 'Sally is a teasing nickname for Caedrel. During the 2024 LEC Summer final, he said viewers could call him Sally if Fnatic lost despite their huge lead over G2. Fnatic lost, and chat kept the name.',
      origin: 'Caedrel’s reaction to Fnatic vs G2, game three of the 2024 LEC Summer final. The nickname refers to Caedrel, not another player or a separate person.',
      references: [
        { title: 'Caedrel Clips: the Sally moment (around 0:40)', url: 'https://www.youtube.com/watch?v=94IJhyFbTIE&t=40s' },
        { title: 'Contemporaneous match and nickname report', url: 'https://game.udn.com/game/story/122089/8125883' },
      ],
    }],
  },
  {
    channelId: '411377640', login: 'jynxzi', displayName: 'Jynxzi',
    entries: [{
      id: 'starter-jynxzi-junko', term: 'Junko', aliases: [], category: 'Character',
      explanation: 'Junko is a nickname for Jynxzi himself, the Rainbow Six Siege streamer. When his chat says Junko, they mean him.',
      origin: 'Wikipedia lists Junko among his other names. Fans repeat several origin stories; this reference does not claim a verified first use.',
      references: [
        { title: 'Jynxzi on Wikipedia (other names)', url: 'https://en.wikipedia.org/wiki/Jynxzi' },
        { title: 'Jynxzi Twitch profile', url: 'https://www.twitch.tv/jynxzi/about' },
      ],
    }],
  },
  {
    channelId: '641972806', login: 'kaicenat', displayName: 'Kai Cenat',
    entries: [{
      id: 'starter-kaicenat-mafia', term: 'Mafia', aliases: ['kai mafia'], category: 'Tradition',
      explanation: 'The Mafia, or Kai Mafia, is the name for Kai Cenat’s fanbase.',
      origin: 'Coverage of his subathons names his fanbase the “Kai Mafia”, and his Mafiathon streams are named after it. This reference does not claim a first use.',
      references: [
        { title: 'Dexerto: Kai Cenat Mafiathon 2 explained', url: 'https://dexerto.com/twitch/kai-cenat-mafiathon-2-explained-everything-you-need-to-know-2971955' },
      ],
    }, {
      id: 'starter-kaicenat-mafiathon', term: 'Mafiathon', aliases: ['mafiathons'], category: 'Tradition',
      explanation: 'A Mafiathon is one of Kai Cenat’s marathon subathons: a stream that runs around the clock for weeks, named after his fanbase, the Kai Mafia.',
      origin: 'The first Mafiathon began on February 1, 2023; Mafiathon 2 followed in November 2024.',
      references: [
        { title: 'Dexerto: Kai Cenat Mafiathon 2 explained', url: 'https://dexerto.com/twitch/kai-cenat-mafiathon-2-explained-everything-you-need-to-know-2971955' },
        { title: 'Tubefilter: Mafiathon 2', url: 'https://www.tubefilter.com/2024/12/02/kai-cenat-twitch-mafiathon-2-subathon/' },
      ],
    }],
  },
  {
    channelId: '220476955', login: 'ishowspeed', displayName: 'IShowSpeed',
    entries: [{
      id: 'starter-ishowspeed-sewey', term: 'Sewey', aliases: ['sewy'], category: 'Inside joke',
      explanation: 'Sewey is IShowSpeed’s take on “Siuuu”, the shout in Cristiano Ronaldo’s trademark goal celebration, which Speed performs as a tribute to his idol.',
      origin: 'Speed released the song “Ronaldo (Sewey)” in June 2022, following his newfound admiration for Ronaldo.',
      references: [
        { title: 'IShowSpeed on Wikipedia (music career)', url: 'https://en.wikipedia.org/wiki/IShowSpeed' },
        { title: 'Sports Illustrated: IShowSpeed and Ronaldo', url: 'https://www.si.com/soccer/ishowspeed-teams-up-with-ronaldo-for-celebratory-stunt' },
      ],
    }],
  },
  {
    channelId: '22484632', login: 'forsen', displayName: 'forsen',
    entries: [{
      id: 'starter-forsen-bajs', term: 'Bajs', aliases: ['forsen bajs'], category: 'Tradition',
      explanation: 'Bajs is what forsen’s viewers are called, and what they call themselves. It is Swedish slang for poop; saying it marks you as part of his chat.',
      origin: 'forsen is a Swedish streamer, and the self-deprecating Swedish word stuck to his community. This reference does not claim a first use.',
      references: [
        { title: 'StreamLadder: the bajs emote', url: 'https://www.streamladder.com/emotes/bajs' },
        { title: 'Wiktionary: bajs (Swedish)', url: 'https://en.wiktionary.org/wiki/bajs' },
      ],
    }],
  },
  {
    channelId: '51496027', login: 'loltyler1', displayName: 'Tyler1',
    entries: [{
      id: 'starter-tyler1-reformed', term: 'Reformed', aliases: ['reformed tyler1'], category: 'Inside joke',
      explanation: '“Reformed” is Tyler1’s running joke about himself. Once called League of Legends’ most toxic player, he branded himself its “most reformed player” after serving his ban.',
      origin: 'Riot banned his accounts in 2016. When the ban was lifted in January 2018, after 613 days, his profile declared him the game’s “most reformed player.”',
      references: [
        { title: 'PCGamesN: Tyler1 is unbanned', url: 'https://www.pcgamesn.com/league-of-legends/tyler1-unbanned' },
      ],
    }],
  },
  {
    channelId: '23936415', login: 'jerma985', displayName: 'Jerma985',
    entries: [{
      id: 'starter-jerma985-jermamites', term: 'Jermamites', aliases: ['jermamite'], category: 'Tradition',
      explanation: 'Jermamites are fans of Jerma985; it is the name his community goes by.',
      origin: 'Listed as Jerma985’s fandom name in Wikipedia’s list of fandom names. This reference does not claim a first use.',
      references: [
        { title: 'Wikipedia: List of fandom names', url: 'https://en.wikipedia.org/wiki/List_of_fandom_names' },
        { title: 'Jerma985 Twitch profile', url: 'https://www.twitch.tv/jerma985/about' },
      ],
    }],
  },
] as const;

export function starterLore(channelId: string): Lore[] {
  const community = communities.find(item => item.channelId === channelId);
  return community?.entries.map(entry => ({ ...entry, aliases: [...entry.aliases], references: entry.references.map(reference => ({ ...reference })), category: entry.category, status: 'approved', source: 'starter', clipUrl: '', votes: 0, createdAt: '2026-11-02T00:00:00.000Z' })) || [];
}

// The channel being watched answers first; otherwise another community's phrase, named as theirs.
export function communitySlang(channelId: string, question: string): { entry: Lore; community: string } | undefined {
  const ordered = [...communities].sort((a, b) => Number(b.channelId === channelId) - Number(a.channelId === channelId));
  for (const community of ordered) {
    const entry = answerLoreQuestion(starterLore(community.channelId), question);
    if (entry) return { entry, community: community.displayName };
  }
}
