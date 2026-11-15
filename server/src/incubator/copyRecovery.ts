import type {AppConfig} from '../config.ts';
import type {IncubatorStore} from './store.ts';

/** Revalidate a delayed copy without enrolling evidence or reviving a retired allocation. */
export function copyRecoveryRefusal(store:IncubatorStore,mirror:AppConfig['incubator']['mirror'],
 cell:{scannerId:string;symbol:string;tf:string},at=Date.now()):string|null{
 if(!mirror?.enabled)return 'copy pilot disabled';
 const quarantine=store.quarantineReason(cell.scannerId);
 if(quarantine)return `scanner quarantined: ${quarantine}`;
 const pair=store.find(cell.scannerId,cell.symbol,cell.tf);
 if(!pair||!['shadow','proposed','live','demote_proposed'].includes(pair.stage))return 'copy allocation no longer admitted';
 if(pair.stage==='live')return null; // Same approved-account rule used by ShadowRunner.
 return store.copyRefusal(pair,mirror,store.marketsToday(at).get(cell.symbol)?.turnoverUsd??null,at,{readOnly:true});
}
