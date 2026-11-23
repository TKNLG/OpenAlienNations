// Mission briefing: title, the mission's own briefing text (from the player's game data) and
// the win/loss goals in plain words. Goal semantics: docs/formats/mdb.md "Goals".

import type { Mission, Goal } from '../formats/mission.ts';
import type { ObjectRule } from '../formats/odb.ts';
import { t } from './i18n.ts';

/** a race's name (our own text: the goal lines have no DV.tdb strings at hand) */
export const raceName = (race: number): string => [t('Amazonen'), t('Pimmons'), t('Sajiki')][race] ?? '?';
const relation = (r: number): string => [t('keine Beziehung'), t('Krieg'), t('Waffenstillstand'), t('Frieden')][r] ?? String(r);

export function describeGoal(g: Goal, race: number, rules: Map<number, ObjectRule>): string {
  const obj = (group: number, type: number) => rules.get(((group << 16) | type) >>> 0)?.name ?? t('Typ {0}', type);
  const good = (ty: number) => obj(6, ty);
  const city = (n: number) => (n <= 1 ? t('in deiner ersten Stadt') : t('in deiner Stadt {0}', n));
  const theirCity = (n: number) => (n <= 1 ? t('in ihrer ersten Stadt') : t('in ihrer Stadt {0}', n));
  switch (g.type) {
    case 1: return t('{0} {1} auf Lager {2}', g.p2, good(g.p1), city(g.p3));
    case 2: return t('{0}× {1} fertiggestellt {2}', g.p2, obj(race, g.p1), city(g.p3));
    case 3: return t('{0} fertige Gebäude {1}', g.p1, city(g.p2));
    case 4: return `${g.p2}× ${obj(race, g.p1)} ${city(g.p3)}`;
    case 5: return t('{0} Einwohner {1}', g.p1, city(g.p2));
    case 6: return t('Kriminalität höchstens {0} % {1}', g.p1, city(g.p2));
    case 7: return t('Zufriedenheit mindestens {0} {1}', g.p1, city(g.p2));
    case 8: return g.p1 === 0 ? t('keine offenen Wünsche {0}', city(g.p2)) : t('höchstens {0} offene Wünsche {1}', g.p1, city(g.p2));
    case 9: return t('mindestens {0} offene Wünsche {1}', g.p1, city(g.p2));
    case 10: return t('Zufriedenheit höchstens {0} {1}', g.p1, city(g.p2));
    case 11: return t('Beziehung zu den {0}: {1}', raceName(g.p1), g.p2 < 0 ? t('keine') : relation(g.p2));
    case 12: return t('die {0} haben kein(e) {1} mehr {2}', raceName(g.p1), obj(g.p1, g.p2), theirCity(g.p3));
    case 13: return t('die {0} sind ausgelöscht', raceName(g.p1));
    case 14: return t('{0} {1} im Lager der Pimmons (Stadt {2})', g.p2, good(g.p1), g.p3);
    case 15: return g.p2 === 0 ? t('kein(e) {0} mehr {1}', obj(race, g.p1), city(g.p3)) : t('höchstens {0}× {1} {2}', g.p2, obj(race, g.p1), city(g.p3));
    case 16: return t('{0} Gold in der Kasse', g.p1);
    default: return t('Ziel {0}', g.type);
  }
}

/** show the briefing panel; resolves when the player clicks "Los geht's" */
export function showBriefing(m: Mission, race: number, rules: Map<number, ObjectRule>): Promise<void> {
  const box = document.getElementById('briefing')!;
  box.innerHTML = '';
  const h = document.createElement('h2'); h.textContent = m.title;
  const who = document.createElement('div'); who.className = 'dim';
  const opponents = m.races.filter(r => r.present && r.race !== race).map(r => raceName(r.race));
  who.textContent = t('Du spielst die {0}', raceName(race)) + (opponents.length ? t(' · Gegenüber: {0}', opponents.join(', ')) : '');
  const text = document.createElement('div'); text.className = 'brief-text';
  text.textContent = m.briefing;
  const goals = document.createElement('ul');
  for (const g of m.goals) {
    const li = document.createElement('li');
    li.textContent = (g.defeat ? t('Niederlage, wenn: ') : t('Ziel: ')) + describeGoal(g, race, rules);
    if (g.defeat) li.className = 'lose';
    goals.append(li);
  }
  const go = document.createElement('button'); go.textContent = t('Los geht’s');
  box.append(h, who, text, goals, go);
  box.hidden = false;
  return new Promise(resolve => { go.onclick = () => { box.hidden = true; resolve(); }; });
}
