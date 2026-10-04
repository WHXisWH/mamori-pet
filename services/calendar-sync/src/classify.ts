import type { ContextCategory } from '@ijime/api-types';
import type { ContextKeywords } from '@ijime/kb-loader';

// 全角と半角をそろえ、カタカナをひらがなに、英字を小文字にする
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .toLowerCase();
}

export type Classifier = (title: string) => ContextCategory | null;

export function createClassifier(table: ContextKeywords): Classifier {
  const rules = table.categories.map((c) => ({
    category: c.category,
    keywords: c.keywords.map(normalize),
  }));
  return (title) => {
    const t = normalize(title);
    return rules.find((r) => r.keywords.some((k) => t.includes(k)))?.category ?? null;
  };
}

export type LinkableChild = { childId: string; nickname: string };

// タイトルに子どものニックネームが含まれるときは、その子どもだけに紐づける。含まれなければ全員に紐づける
export function linkChildren(title: string, children: LinkableChild[]): string[] {
  const t = normalize(title);
  const named = children.filter((c) => c.nickname && t.includes(normalize(c.nickname)));
  return (named.length ? named : children).map((c) => c.childId);
}
