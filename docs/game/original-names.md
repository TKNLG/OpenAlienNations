# Original names (from the Mac build)

The Macintosh (PowerPC) port of the game was built from the same source, Gold Edition era (it has
the island and ship code), and kept its C++ symbol names: class, method and parameter types, plus
the source file names (`town.cpp`, `aitownbuildofficer.cpp`, ...). This page lists what those names
tell us about the PC executables. They are identifiers only: the rules are still read from the PC
exes, which stay the authority for vanilla behaviour.

## 1. Where the names come from and how far to trust them

- Source: a community IDA database of the Mac build (`github.com/ShaneDoyle/Alien-Nations-IDA`,
  which also holds 222 names ported by hand onto a Gold exe of version 3.03). Kept privately in
  `re/`; the workflow is in `status.md` §2.
- Object layouts agree between the builds (e.g. the Mac `Town::CheckMotivationBuildings` reads town
  +0x44 like the PC code in `economy.md`), so field offsets carry over.
- The names are put onto `dvge.exe` by structural matching (no shared machine code): the job factory
  (case id = job type, section 2) and vtables give exact pairs for every job class and its virtual
  methods; three handler tables (sections 3 to 5) are aligned by index; the rest comes from
  call-graph propagation, field-offset constants and function order. Measured precision of the
  propagated names is about 97 % (two-fold cross-validation against the hand-ported names).
  `dvge.exe` names go to `AN.exe` through instruction-level matching of the two PC exes, which agreed
  with every Gold = AN pair already in these docs. About 1,100 `dvge.exe` and 920 `AN.exe`
  functions have an original name.
- **Treat a name as a strong hint, not proof.** Before a spec relies on one, check that the code
  fits it. Names from sections 2 to 5 are exact. The 2026-11 fidelity audit read several hundred
  named functions and found about a dozen names that did not fit; those are on a reject list and
  no longer applied (most came from a message table first aligned one slot off, now fixed).
- C runtime functions (`rand`, `memcpy`, float conversion, ...) carry their library names, taken
  from the library signatures in the 3.03 database (about 340 per exe).
- Separately, Ghidra auto-analysis had missed about 650 functions per exe that are reachable only
  through vtables (virtual methods); `re/dump*` now contain them.

## 2. Job types (job +0x10)

From the savegame job factories (Mac `LoadJobStep1`, AN `00402dc0`, Gold `004031c0`). "Run" is
vtable slot 1 (`<Class>::Work`); slots 0, 2, 3 are the destructor, `Save` and `Load`.

| id | original class | name in `units-and-jobs.md` 3.1 | AN run | Gold run |
|---|---|---|---|---|
| 0x00 | `TownResourceJob` | town dispatcher | `0046fa10` | `00479480` |
| 0x01 | `TownFoodJob` | (not listed) | `0046f650` | `004790c0` |
| 0x02 | `TownMotivateJob` | (not listed) | `0046f820` | `00479290` |
| 0x03 | `TownUnemployedJob` | town leisure | `00470340` | `00479db0` |
| 0x05 | `DVResourceJob` | transport | `0047c2b0` | `00487040` |
| 0x06 | `DVMoveJob` | follow path | `00480410` | `0048b230` |
| 0x07 | `DVMoveToObjectJob` | go to object | `0047ac90` | `00485750` |
| 0x08 | `DVAttackJob` | attack | `00472b20` | `0047c590` |
| 0x09 | `DVShootJob` | strike | `00481450` | `0048c720` |
| 0x0A | `DVBirthJob` | house | `004749e0` | `0047e4a0` |
| 0x0B | `DVKnockJob` | enter building | `0047a0f0` | `00484690` |
| 0x0C | `DVConstructionJob` | builder | `00477ce0` | `00481710` |
| 0x0D | `DVMoveOutJob` | leave building | `0047a530` | `00484e00` |
| 0x0E | `DVFoundationJob` | found town | `00479410` | `00483910` |
| 0x0F | `DVEvadeJob` | step aside | `0047df70` | `00488d90` |
| 0x11 | `DVBuildBuildingJob` | construction | `00475470` | `0047ef30` |
| 0x12 | `DVBuildUnitJob` | training | `00475d50` | `0047f810` |
| 0x13 | `DVProductionJob` | production | `00476380` | `0047fe40` |
| 0x15 | `HitJob` | (not listed) | `00481c40` | `0048ced0` |
| 0x16 | `DVCollectJob` | harvest | `00476a70` | `004804a0` |
| 0x17 | `DVCrimeJob` | criminal | `004784d0` | `00482040` |
| 0x18 | `DVPoliceJob` | arrest | `0047b860` | `004865f0` |
| 0x19 | `DVTortureJob` | escort | `0047cca0` | `00487a30` |
| 0x1A | `DVPaperBoyJob` | news round | `0047b490` | `00486220` |
| 0x1B | `DVCastleAttackJob` | garrison fire | `004736c0` | `0047d180` |
| 0x1C | `CastleJob` | outpost | `00473850` | `0047d310` |
| 0x1D | `TreeGrowJob` | growth | `00481e90` | `0048d120` |
| 0x1E | `GrowJob` | bush regrowth | `00482110` | `0048d3a0` |
| 0x1F | `IdleAnimJob` | turn | `0047f030` | `00489e50` |
| 0x20 | `DVTraderJob` | trade | `0047ce00` | `00487b90` |
| 0x21 | `FarmerJob` | plant | `0047ead0` | `004898f0` |
| 0x22 | `DVDistributionJob` | operator | `00478cb0` | `00482960` |
| 0x24 | `DVAnimalJob` | animal | `004743b0` | `0047de70` |
| 0x25 | `DVPullDownJob` | ? | `0047bd60` | `00486af0` |
| 0x26 | `DVEscapeJob` | flee | `0047da50` | `00488870` |
| 0x27 | `DVPatrolJob` | guard | `00480a10` | `0048bce0` |
| 0x28 | `DVScoutJob` | group move (wrong: scout job) | `0047c970` | `00487700` |
| 0x29 | `DVPriestJob` | heal | `00481180` | `0048c450` |
| 0x2A | `DVEatBushJob` | eat crop | `00473d50` | `0047d810` |
| 0x2B | `DVHuntsmanJob` | hunting ground | `00479800` | `00483d00` |
| 0x2C | `PlayerFinancialJob` | (not listed) | `0046edd0` | `004784c0` |
| 0x2D | `PlayerGoalJob` | (not listed) | `0046ee40` | `00478530` |
| 0x2E | `InventionJob` | (not listed) | `0046f490` | `00478f00` |
| 0x2F | `DialogUpdateJob` | (not listed) | `0046ed90` | `00478480` |
| 0x30 | `AIGeneral` | (not listed) | `004685d0` | `0046fb90` |
| 0x31 | `AIOfficer` | (not listed) |  | `00471ef0` |
| 0x32 | `AITownBuildOfficer` | (not listed) | `0046c890` | `00475b90` |
| 0x33 | `AITownResourceOfficer` | (not listed) | `0046ecd0` | `004783c0` |
| 0x34 | `AITownDefendOfficer` | (not listed) | `0046d9a0` | `00476ca0` |
| 0x35 | `AIAttackOfficer` | (not listed) | `004673d0` | `0046dfa0` |
| 0x36 | `AICityFoundOfficer` | (not listed) | `00467f80` | `0046f340` |
| 0x37 | `OekoJob` | nature respawn | `004826a0` | `0048d920` |
| 0x38 | `DVDiplomacyJob` | operator errand | `00478910` | `004825c0` |
| 0x39 | `AutoSaveJob` | (not listed) |  | `0048d400` |
| 0x3A | `DVFishermanJob` (Gold only) | (add-on fishing) |  | `004830b0` |
| 0x3C | `DVUnitOrderJob` | answer request | `0047d940` | `00488700` |

Gold-only jobs (constructors in `addon.md` Appendix B; the Mac build compiles these source files
empty, so its factory lacks them): 0x3A `DVFishermanJob` (fishing), 0x3B `MoveToIsleJob` (sail to
coast), 0x3D `AIReedOfficer` (the ship AI; its constructor passes type 0x3D to the `AIOfficer`
base), 0x3E `DVWaitJob`.

Notes: 0x15 `HitJob` is the impact job of `combat.md` §5; 0x0A, the house resident job, is the birth job; 0x0B, entering, is "knock" (knocking at the
door); 0x19, the job created by an arrest, is "torture" (the interrogation); 0x25, created when a
building is destroyed, is "pull down" (the building's collapse job, `combat.md` 10.3); 0x37, the nature respawn, is the ecology job (`OekoJob`).
**0x28 is the scout job** (`DVScoutJob`, created by `CheckScouts` `00468e10`), not a group move:
3.1 needs correcting. 0x2C..0x36 are player and AI jobs (finances, mission goals, research, dialog
refresh, the AI general and its officers), 0x39 the autosave.

## 3. Mission goal types (`mdb.md`, goals)

Goal check table (Gold `004bd198`, one function per type; types 1, 2 and the Gold goals 17..20 have
no Mac entry in this table):

| type | original name | Gold | AN |
|---|---|---|---|
| 3 | `BuildingCount` | `004787a0` |  |
| 4 | `SpecificUnitCount` | `004787e0` |  |
| 5 | `UnitCount` | `00478830` |  |
| 6 | `CriminalRate` | `00478870` |  |
| 7 | `MoralMore` | `00478930` |  |
| 8 | `NeedsLess` | `004788b0` |  |
| 9 | `NeedsMore` | `004788f0` |  |
| 10 | `MoralLess` | `00478970` |  |
| 11 | `Diplomacy` | `004789b0` | `0046f2c0` |
| 12 | `DestroyBuildings` | `00478a20` | `0046f330` |
| 13 | `PartyDestroyed` | `00478a70` | `0046f380` |
| 14 | `PimmonResources` | `00478aa0` | `0046f3b0` |
| 15 | `UnitsLess` | `00478af0` |  |
| 16 | `CreditsMore` | `00478b40` | `0046f450` |

## 4. Dialog handlers

Dialog open table (Gold `004bc448`, index from 1):

| index | original name | Gold | AN |
|---|---|---|---|
| 1 | `dlg_groupinfo` | `00416c90` | `00413730` |
| 2 | `dlg_towninfo` | `00416d10` |  |
| 3 | `dlg_research` | `00416db0` | `00413850` |
| 4 | `dlg_histroy` | `00416e30` | `004138d0` |
| 5 | `dlg_buildbuildings` | `00416eb0` | `00413950` |
| 6 | `dlg_buildunits` | `00416f30` |  |
| 7 | `dlg_motivation` | `00416fd0` |  |
| 8 | `dlg_citizen` | `00417060` |  |
| 9 | `dlg_resources` | `00417100` |  |
| 10 | `dlg_sale` | `00417170` | `00413bf0` |
| 11 | `dlg_purchase` | `004171f0` | `00413c70` |
| 12 | `dlg_trader` | `00417270` | `00413cf0` |
| 13 | `dlg_diplomacy` | `004172f0` | `00413d70` |
| 14 | `dlg_buildingsite` | `00417370` | `00413df0` |
| 15 | `dlg_production` | `004173f0` |  |
| 16 | `dlg_resourceinfo` | `00417490` |  |
| 17 | `dlg_buildings` | `00417530` |  |

## 5. Message types (commands)

Message factory table (AN `0x4AFCE0`, Gold `004bce58`): slot s creates message type s + 1 (type byte
at message +8). The handler of a type is slot 0 of its vtable, `Msg<Name>::InterpretMessage`. The
"command 0x.." numbers in `units-and-jobs.md` and `combat.md` are these type bytes (e.g. 0x15
UnitAction = the unit orders, AN `00450bb0`; 0x2A IdleAnim = the idle fidget, `00452000`; 0x3A
ObjectDismiss = send out, `004520e0`). Handlers without an address were not matched.

| type | original name | AN handler | Gold handler |
|---|---|---|---|
| 0x02 | `ObjectMove` |  |  |
| 0x03 | `ObjectTurn` |  |  |
| 0x04 | `ObjectType` | `00455a80` | `0045b6d0` |
| 0x05 | `ObjectGoesIn` | `00455ad0` | `0045b720` |
| 0x06 | `ObjectBuildingProgress` |  |  |
| 0x07 | `ObjectSetAnimationSet` |  |  |
| 0x08 | `CmdDeactivate` | `00450860` | `00456230` |
| 0x09 | `CmdResearch` | `00450910` | `004562e0` |
| 0x0A | `DlgConstructableUnits` |  |  |
| 0x0B | `StopResearch` |  |  |
| 0x0C | `DlgResConstructableBuildings` |  |  |
| 0x0D | `CmdSelectTown` |  |  |
| 0x0E | `DlgUnitInfo` |  |  |
| 0x0F | `DlgBuildingInfo` |  |  |
| 0x10 | `DlgGroupInfo` |  |  |
| 0x11 | `DlgTownInfo` |  |  |
| 0x12 | `DlgResearch` |  |  |
| 0x13 | `CmdFoundCity` | `004509d0` | `004563a0` |
| 0x14 | `LocalAction` |  |  |
| 0x15 | `UnitAction` | `00450bb0` | `004567a0` |
| 0x16 | `CmdBuildUnit` |  |  |
| 0x17 | `CmdBuildBuilding` | `00451780` | `004571e0` |
| 0x18 | `HitObject` |  |  |
| 0x19 | `StartAnim` |  |  |
| 0x1A | `MainButtonPressed` | `00451ac0` | `00457550` |
| 0x1B | `Shoot` |  |  |
| 0x1C | `NewTown` | `00456740` | `0045c3b0` |
| 0x1D | `GotoTown` |  |  |
| 0x1E | `ObjectDestroy` | `00456770` | `0045c3e0` |
| 0x1F | `SetLocalPosition` |  |  |
| 0x20 | `CmdMoveHome` |  |  |
| 0x21 | `CmdPullDown` |  |  |
| 0x22 | `DlgResources` |  |  |
| 0x23 | `DlgCitizen` |  |  |
| 0x24 | `CmdRemoveResource` | `00451f10` | `004579a0` |
| 0x25 | `DlgDiplomacy` |  |  |
| 0x26 | `SetFrame` | `004567b0` | `0045c420` |
| 0x27 | `StopAnim` |  |  |
| 0x28 | `Mark` | `00450700` | `004560d0` |
| 0x29 | `CmdAbortBuild` | `00451fc0` | `00457a50` |
| 0x2A | `IdleAnim` | `00452000` | `00457a90` |
| 0x2B | `ObjectOpenDoor` | `004568a0` | `0045c510` |
| 0x2C | `ObjectCloseDoor` | `004568e0` | `0045c550` |
| 0x2D | `ObjectPlayAnims` | `00456920` | `0045c590` |
| 0x2E | `ObjectActivate` | `004569a0` | `0045c610` |
| 0x2F | `ObjectDeactivate` | `004569e0` | `0045c650` |
| 0x30 | `BuildCityhall` |  |  |
| 0x31 | `DlgBuildingSite` |  |  |
| 0x32 | `DlgMotivation` |  |  |
| 0x33 | `DlgPurchase` |  |  |
| 0x34 | `DlgSale` |  |  |
| 0x35 | `DlgTrader` |  |  |
| 0x36 | `CmdLocalPause` | `004528b0` | `00458360` |
| 0x37 | `DlgHistory` |  |  |
| 0x38 | `ResearchFinished` | `00457190` | `0045ce90` |
| 0x39 | `DlgProduction` |  |  |
| 0x3A | `ObjectDismiss` | `004520e0` | `00457b70` |
| 0x3B | `ObjectWasBuilt` | `00457250` | `0045cf50` |
| 0x3C | `GameOver` | `00457460` | `0045d160` |
| 0x3D | `Dlg` | `00455d00` | `0045b950` |
| 0x3E | `DlgResourceInfo` |  |  |
| 0x3F | `Credits` |  |  |
| 0x40 | `ObjectStopAnims` | `00456960` | `0045c5d0` |
| 0x41 | `ActivateTown` | `00457a60` | `0045d770` |
| 0x42 | `DeactivateTown` |  |  |
| 0x43 | `CmdGotoObject` |  |  |
| 0x44 | `DlgBuildings` |  |  |
| 0x45 | `CmdTradingLot` |  |  |
| 0x46 | `CmdTraderStart` |  |  |
| 0x47 | `CmdTraderStop` |  |  |
| 0x48 | `CmdSetMotivationInv` |  |  |
| 0x49 | `ObjectSetAnimationFrame` |  |  |
| 0x4A | `ObjectBackwardAnimation` |  |  |
| 0x4B | `CmdSetTownName` |  |  |
| 0x4C | `RemoveTown` | `00457d70` | `0045da80` |
| 0x4D | `MentorTalk` | `00457d90` | `0045daa0` |
| 0x4E | `CmdPatrol` | `00452790` | `00458220` |
| 0x4F | `AddPatrolPoint` | `00452840` | `004582e0` |
| 0x50 | `SetPaused` | `00457db0` | `0045dac0` |
| 0x51 | `LocalReady` |  |  |
| 0x52 | `CmdSetResearchInv` |  |  |
| 0x53 | `CmdRemoveUnitResource` |  |  |
| 0x54 | `CmdRepair` | `00452a70` | `004585d0` |
| 0x55 | `Outpost` | `004572c0` | `0045cfc0` |
| 0x56 | `SetDiplomacy` | `00452a90` | `004585f0` |
| 0x57 | `CmdFood` | `00476630` | `004800f0` |
| 0x58 | `CmdSale` |  |  |
| 0x59 | `CmdPurchase` |  |  |
| 0x5A | `CmdDiplomacy` | `00452c90` | `004587f0` |
| 0x5B | `SetRelation` |  |  |
| 0x5C | `MakeVisible` | `00458530` | `0045e260` |
| 0x5D | `RemoveFromHash` |  |  |
| 0x5E | `TownProblem` | `004586f0` | `0045e420` |
| 0x5F | `CmdPauseBuild` | `00452d20` | `00458880` |
| 0x60 | `CmdAbortDiplomacy` |  |  |
| 0x61 | `ObjectMark` |  |  |
| 0x62 | `RefreshMainDlg` |  |  |
| 0x63 | `PlaySfx` |  |  |
| 0x64 | `ObjectGoesOut` | `00455b30` | `0045b780` |
| 0x65 | `SetTimerIntervall` |  |  |
