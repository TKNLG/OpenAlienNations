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
  with every Gold = AN pair already in these docs. About 1,140 `dvge.exe` and 970 `AN.exe`
  functions have an original name.
- **Treat a name as a strong hint, not proof.** Before a spec relies on one, check that the code
  fits it. Names from sections 2 to 5 are exact.
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
| 0x28 | `DVScoutJob` | group move | `0047c970` | `00487700` |
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
| 0x3A | (Gold only, not in the Mac factory) | (not listed) |  | `004830b0` |
| 0x3C | `DVUnitOrderJob` | answer request | `0047d940` | `00488700` |

Notes: 0x0A, the house resident job, is the birth job; 0x0B, entering, is "knock" (knocking at the
door); 0x19, the job created by an arrest, is "torture" (the interrogation); 0x25, created when a
building is destroyed, is "pull down"; 0x37, the nature respawn, is the ecology job (`OekoJob`).
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

## 5. Network message types

Message handler table (Gold `004bce58`, index = message type). These are the message classes
(`Msg<Name>`) sent between the simulation and the clients; the unit orders called "command 0x.." in
`units-and-jobs.md` are a separate numbering inside `MsgUnitAction::InterpretMessage` (AN `00450bb0`).

| type | original name | Gold | AN |
|---|---|---|---|
| 0x00 | `ObjectMove` | `00458fe0` | `00453480` |
| 0x01 | `ObjectTurn` | `00459010` | `004534b0` |
| 0x02 | `ObjectType` | `00459040` |  |
| 0x03 | `ObjectGoesIn` | `00459060` |  |
| 0x04 | `ObjectBuildingProgress` | `00459080` |  |
| 0x05 | `ObjectSetAnimationSet` | `004590a0` |  |
| 0x06 | `CmdDeactivate` | `004590c0` |  |
| 0x07 | `CmdResearch` | `004590e0` | `00453580` |
| 0x08 | `DlgConstructableUnits` | `00459110` |  |
| 0x09 | `StopResearch` | `00459130` |  |
| 0x0A | `DlgResConstructableBuildings` | `00459160` | `00453600` |
| 0x0B | `CmdSelectTown` | `00459190` |  |
| 0x0C | `DlgUnitInfo` | `004591c0` |  |
| 0x0D | `DlgBuildingInfo` | `004591e0` |  |
| 0x0E | `DlgGroupInfo` | `00459200` | `004536a0` |
| 0x0F | `DlgTownInfo` | `00459220` |  |
| 0x10 | `DlgResearch` | `00459240` | `004536e0` |
| 0x11 | `CmdFoundCity` | `00459260` | `00453700` |
| 0x12 | `LocalAction` | `00459280` |  |
| 0x13 | `UnitAction` | `004592d0` |  |
| 0x14 | `CmdBuildUnit` | `004592b0` | `00453750` |
| 0x15 | `CmdBuildBuilding` | `004592f0` |  |
| 0x16 | `HitObject` | `00459310` | `004537b0` |
| 0x17 | `StartAnim` | `00459330` |  |
| 0x18 | `MainButtonPressed` | `00459350` |  |
| 0x19 | `Shoot` | `00459370` |  |
| 0x1A | `NewTown` | `00459390` | `00453830` |
| 0x1B | `GotoTown` | `004593c0` |  |
| 0x1C | `ObjectDestroy` | `004593f0` |  |
| 0x1D | `SetLocalPosition` | `00459410` |  |
| 0x1E | `CmdMoveHome` | `00459430` |  |
| 0x1F | `CmdPullDown` | `00459450` | `004538e0` |
| 0x20 | `DlgResources` | `00459480` | `00453910` |
| 0x21 | `DlgCitizen` | `004594b0` | `00453940` |
| 0x22 | `CmdRemoveResource` | `004594d0` |  |
| 0x23 | `DlgDiplomacy` | `004594f0` |  |
| 0x24 | `SetFrame` | `00459510` | `004539a0` |
| 0x25 | `StopAnim` | `00459530` |  |
| 0x26 | `Mark` | `00459550` |  |
| 0x27 | `CmdAbortBuild` | `00459570` | `00453a00` |
| 0x28 | `IdleAnim` | `00459590` |  |
| 0x29 | `ObjectOpenDoor` | `004595b0` |  |
| 0x2A | `ObjectCloseDoor` | `004595d0` |  |
| 0x2B | `ObjectPlayAnims` | `004595f0` |  |
| 0x2C | `ObjectActivate` | `00459610` |  |
| 0x2D | `ObjectDeactivate` | `00459650` |  |
| 0x2E | `BuildCityhall` | `00459670` |  |
| 0x2F | `DlgBuildingSite` | `00459690` |  |
| 0x30 | `DlgMotivation` | `004596b0` | `00453b40` |
| 0x31 | `DlgPurchase` | `004596d0` | `00453b60` |
| 0x32 | `DlgSale` | `004596f0` |  |
| 0x33 | `DlgTrader` | `00459720` |  |
| 0x34 | `CmdLocalPause` | `00459750` | `00453be0` |
| 0x35 | `DlgHistory` | `00459aa0` |  |
| 0x36 | `ResearchFinished` | `00459770` |  |
| 0x37 | `DlgProduction` | `00459790` |  |
| 0x38 | `ObjectDismiss` | `004597b0` | `00453c40` |
| 0x39 | `ObjectWasBuilt` | `004597d0` |  |
| 0x3A | `GameOver` | `004597f0` |  |
| 0x3B | `Dlg` | `00459810` |  |
| 0x3C | `DlgResourceInfo` | `00459830` |  |
| 0x3D | `Credits` | `00459850` |  |
| 0x3E | `ObjectStopAnims` | `00459870` |  |
| 0x3F | `ActivateTown` | `00459630` |  |
| 0x40 | `DeactivateTown` | `00459890` |  |
| 0x41 | `CmdGotoObject` | `004598b0` |  |
| 0x42 | `DlgBuildings` | `004598d0` |  |
| 0x43 | `CmdTradingLot` | `004598f0` |  |
| 0x44 | `CmdTraderStart` | `00459910` | `00453da0` |
| 0x45 | `CmdTraderStop` | `00459930` |  |
| 0x46 | `CmdSetMotivationInv` | `00459950` | `00453de0` |
| 0x47 | `ObjectSetAnimationFrame` | `00459980` |  |
| 0x48 | `ObjectBackwardAnimation` | `004599a0` |  |
| 0x49 | `CmdSetTownName` | `004599c0` |  |
| 0x4A | `RemoveTown` | `004599e0` | `00453e70` |
| 0x4B | `MentorTalk` | `00459a00` |  |
| 0x4C | `CmdPatrol` | `00459a20` |  |
| 0x4D | `AddPatrolPoint` | `00459a40` | `00453ed0` |
| 0x4E | `SetPaused` | `00459a70` |  |
| 0x4F | `LocalReady` | `00459ac0` |  |
| 0x50 | `CmdSetResearchInv` | `00459ae0` | `00453f70` |
| 0x51 | `CmdRemoveUnitResource` | `00459b10` |  |
| 0x52 | `CmdRepair` | `00459b30` | `00453fc0` |
| 0x53 | `Outpost` | `00459b60` | `00453ff0` |
| 0x54 | `SetDiplomacy` | `00459b90` | `00454020` |
| 0x55 | `CmdFood` | `00459bb0` |  |
| 0x56 | `CmdSale` | `00459bd0` |  |
| 0x57 | `CmdPurchase` | `00459bf0` |  |
| 0x58 | `CmdDiplomacy` | `00459c10` |  |
| 0x59 | `SetRelation` | `00459c30` |  |
| 0x5A | `MakeVisible` | `00459c50` |  |
| 0x5B | `RemoveFromHash` | `00459c70` |  |
| 0x5C | `TownProblem` | `00459c90` |  |
| 0x5D | `CmdPauseBuild` | `00459cb0` |  |
| 0x5E | `CmdAbortDiplomacy` | `00459cd0` | `00454160` |
| 0x5F | `ObjectMark` | `00459d00` | `00454190` |
| 0x60 | `RefreshMainDlg` | `00459d30` |  |
| 0x61 | `PlaySfx` | `00459d50` | `004541e0` |
| 0x62 | `ObjectGoesOut` | `00459d80` |  |
| 0x63 | `SetTimerIntervall` | `00459da0` | `00454230` |
