import {z} from 'zod';
export const botPromotionSelectionSchema=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('none')}).strict(),
 z.object({mode:z.literal('explicit_code'),code:z.string().trim().min(1).max(50).transform(s=>s.toUpperCase())}).strict(),
 z.object({mode:z.literal('bot_approved')}).strict(),
]);
const policy=z.object({version:z.literal(1),enabled:z.boolean(),codes:z.array(z.object({code:z.string().trim().min(1).max(50).transform(s=>s.toUpperCase()),bot_auto_apply:z.boolean(),bot_priority:z.number().int().min(0).max(10000)}).strict()).max(100)}).strict();
/** Dedicated WaWi setting; absence, disabled or malformed policy grants nobody access. */
export function approvedBotPromos(value:string|null|undefined):Map<string,number>{
 try{const parsed=policy.safeParse(JSON.parse(value||'null'));if(!parsed.success||!parsed.data.enabled)return new Map();
 const entries=parsed.data.codes;if(new Set(entries.map(x=>x.code)).size!==entries.length)return new Map();
 return new Map(entries.filter(x=>x.bot_auto_apply).map(x=>[x.code,x.bot_priority]));}catch{return new Map();}
}
