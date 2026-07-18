import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { exportPersonaFeedbackObservation } from "../packages/core/src/persona-feedback-observation";

async function main(){let written: any;let puts=0;const node={put:async(_d:unknown,_k:string,v:unknown)=>{written=v;puts+=1;},get:()=>written};
const input={guildId:"g",channelId:"c",messageId:"m",authorId:"a",authorName:"human",observedAt:"2026-07-18T00:00:00Z",addressingMode:"role" as const,content:"please inspect this",targetPersonaId:"epiphany",targetRepoName:"GameCult/Epiphany",targetRuntimeId:"epiphany-yggdrasil"};
const config={storePath:"unused",bifrostRoot:"unused",producerRuntimeId:"voidbot-yggdrasil"};
const id=await exportPersonaFeedbackObservation(input,config,{definition:{},openNode:async()=>node});
assert.ok(id);assert.equal(written.authorityClass,"feedback_only");assert.equal(written.payloadHash,createHash("sha256").update("please inspect this").digest("hex"));assert.equal(written.targetRuntimeId,"epiphany-yggdrasil");
await exportPersonaFeedbackObservation(input,config,{definition:{},openNode:async()=>node});assert.equal(puts,1);
await assert.rejects(exportPersonaFeedbackObservation({...input,content:"different"},config,{definition:{},openNode:async()=>node}),/different immutable content/);
console.log("persona feedback observation smoke passed");}
void main().catch(error=>{console.error(error);process.exitCode=1;});
