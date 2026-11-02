import type { Lore } from '../shared/types.ts';

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
] as const;

export function starterLore(channelId: string): Lore[] {
  const community = communities.find(item => item.channelId === channelId);
  return community?.entries.map(entry => ({ ...entry, aliases: [...entry.aliases], references: entry.references.map(reference => ({ ...reference })), category: entry.category, status: 'approved', source: 'starter', clipUrl: '', votes: 0, createdAt: '2026-11-02T00:00:00.000Z' })) || [];
}
