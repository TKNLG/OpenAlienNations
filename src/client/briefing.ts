// Mission briefing: title, the mission's own briefing text (from the player's game data) and
// the win/loss goals in plain words. Goal semantics: docs/formats/mdb.md "Goals".

import type { Mission, Goal } from '../formats/mission.ts';
import type { ObjectRule } from '../formats/odb.ts';

const RACES = ['Amazonen', 'Pimmons', 'Sajiki'];
const RELATIONS = ['keine Beziehung', 'Krieg', 'Waffenstillstand', 'Frieden'];

export function describeGoal(g: Goal, race: number, rules: Map<number, ObjectRule>): string {
  const obj = (group: number, type: number) => rules.get(((group << 16) | type) >>> 0)?.name ?? `Typ ${type}`;
  const good = (t: number) => obj(6, t);
  const city = (n: number) => (n <= 1 ? 'in deiner ersten Stadt' : `in deiner Stadt ${n}`);
  const theirCity = (n: number) => (n <= 1 ? 'in ihrer ersten Stadt' : `in ihrer Stadt ${n}`);
  switch (g.type) {
    case 1: return `${g.p2} ${good(g.p1)} auf Lager ${city(g.p3)}`;
    case 2: return `${g.p2}× ${obj(race, g.p1)} fertiggestellt ${city(g.p3)}`;
    case 3: return `${g.p1} fertige Gebäude ${city(g.p2)}`;
    case 4: return `${g.p2}× ${obj(race, g.p1)} ${city(g.p3)}`;
    case 5: return `${g.p1} Einwohner ${city(g.p2)}`;
    case 6: return `Kriminalität höchstens ${g.p1} % ${city(g.p2)}`;
    case 7: return `Zufriedenheit mindestens ${g.p1} ${city(g.p2)}`;
    case 8: return g.p1 === 0 ? `keine offenen Wünsche ${city(g.p2)}` : `höchstens ${g.p1} offene Wünsche ${city(g.p2)}`;
    case 9: return `mindestens ${g.p1} offene Wünsche ${city(g.p2)}`;
    case 10: return `Zufriedenheit höchstens ${g.p1} ${city(g.p2)}`;
    case 11: return `Beziehung zu den ${RACES[g.p1] ?? '?'}: ${g.p2 < 0 ? 'keine' : RELATIONS[g.p2] ?? g.p2}`;
    case 12: return `die ${RACES[g.p1] ?? '?'} haben kein(e) ${obj(g.p1, g.p2)} mehr ${theirCity(g.p3)}`;
    case 13: return `die ${RACES[g.p1] ?? '?'} sind ausgelöscht`;
    case 14: return `${g.p2} ${good(g.p1)} im Lager der Pimmons (Stadt ${g.p3})`;
    case 15: return g.p2 === 0 ? `kein(e) ${obj(race, g.p1)} mehr ${city(g.p3)}` : `höchstens ${g.p2}× ${obj(race, g.p1)} ${city(g.p3)}`;
    case 16: return `${g.p1} Gold in der Kasse`;
    default: return `Ziel ${g.type}`;
  }
}

/** show the briefing panel; resolves when the player clicks "Los geht's" */
export function showBriefing(m: Mission, race: number, rules: Map<number, ObjectRule>): Promise<void> {
  const box = document.getElementById('briefing')!;
  box.innerHTML = '';
  const h = document.createElement('h2'); h.textContent = m.title;
  const who = document.createElement('div'); who.className = 'dim';
  const opponents = m.races.filter(r => r.present && r.race !== race).map(r => RACES[r.race]);
  who.textContent = `Du spielst die ${RACES[race]}` + (opponents.length ? ` · Gegenüber: ${opponents.join(', ')}` : '');
  const text = document.createElement('div'); text.className = 'brief-text';
  text.textContent = m.briefing;
  const goals = document.createElement('ul');
  for (const g of m.goals) {
    const li = document.createElement('li');
    li.textContent = (g.defeat ? 'Niederlage, wenn: ' : 'Ziel: ') + describeGoal(g, race, rules);
    if (g.defeat) li.className = 'lose';
    goals.append(li);
  }
  const go = document.createElement('button'); go.textContent = 'Los geht’s';
  box.append(h, who, text, goals, go);
  box.hidden = false;
  return new Promise(resolve => { go.onclick = () => { box.hidden = true; resolve(); }; });
}
