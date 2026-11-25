import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../js/pdf-study.js',import.meta.url),'utf8');
const context=vm.createContext({window:{},console,Date,Map,Set,JSON,Math});
vm.runInContext(source,context,{filename:'js/pdf-study.js'});
const api=context.window.GuanyiPdfStudy._test;
const plain=value=>JSON.parse(JSON.stringify(value));
const evidence=(id,page,text='原文：这项结论受到材料和条件的限制。',hash='version-a')=>({id,page,pageLabel:String(page),text,rects:[[10,20,100,30]],sourceHash:hash,itemStart:0,itemEnd:2});
const initial=()=>api.normalizeRecord(null,{sourceHash:'version-a',numPages:12});
const response={guide:[{title:'核心论点',body:'应结合条件理解结论。',evidenceIds:['E1'],page:999,quote:'模型伪造引文'}],questions:[{question:'适用条件是什么？',evidenceIds:['E1']}],cards:[{type:'结论与边界',question:'为何不能直接外推？',answer:'需要核对材料和条件。',evidenceIds:['E1']}]};

test('model results can only refer to locally supplied evidence; pages and quotes come from the reader',()=>{
 const pack=api.evidencePack([evidence('real-block',3)]);
 const parsed=api.parsePreparation(JSON.stringify(response),pack,'range-a','version-a');
 assert.equal(parsed.guide[0].sources[0].page,3);
 assert.equal(parsed.guide[0].sources[0].text,'原文：这项结论受到材料和条件的限制。');
 assert.equal(parsed.guide[0].sources[0].sourceHash,'version-a');
 assert.doesNotMatch(JSON.stringify(parsed),/模型伪造引文|999/);
 const invalid=structuredClone(response);invalid.cards[0].evidenceIds=['E999'];
 assert.throws(()=>api.parsePreparation(JSON.stringify(invalid),pack,'range-a','version-a'),/未知来源/);
 assert.throws(()=>api.parseAnswer(JSON.stringify({answer:'不带依据的说法',evidenceIds:[]}),pack),/缺少原文依据/);
 assert.throws(()=>api.parseAnswer(JSON.stringify({answer:'未知来源的说法',evidenceIds:['E42']}),pack),/未知来源/);
 const insufficient=api.parseAnswer(JSON.stringify({insufficient:true,evidenceIds:[]}),pack);
 assert.equal(insufficient.insufficient,true);assert.equal(insufficient.sources.length,0);
});

test('reloading and exporting older insufficient turns suppresses the model conclusion and sources',()=>{
 const data=initial();
 const context={mode:'page',start:3,end:3,sourceHash:'version-a'};
 data.messages=[{id:'old-answer',status:'ready',question:'有测量疼痛吗？',insufficient:true,answer:'无依据的结论',
  sources:[evidence('old-citation',3,'推断所附摘录')],card:{answer:'无依据的结论'},context}];
 const restored=api.normalizeRecord(data,{sourceHash:'version-a'});
 assert.equal(restored.messages[0].id,'old-answer');
 assert.deepEqual(plain(restored.messages[0].context),context);
 assert.match(restored.messages[0].answer,/没有足够原文/);
 assert.equal(restored.messages[0].sources.length,0);
 assert.equal(restored.messages[0].card,undefined);
 for (const record of [data,restored]) {
  const markdown=api.exportMarkdown(record,'旧研读记录');
  assert.match(markdown,/有测量疼痛吗.*没有足够原文/s);
  assert.doesNotMatch(markdown,/无依据的结论|推断所附摘录/);
 }
});

test('abstract quick reading restores and exports separately with its verified sources',()=>{
 const data=initial();
 data.quickPurpose='核对试验方法';
 data.quickReading={sourceHash:'version-a',purpose:data.quickPurpose,takeaway:'两组结果随阶段变化。',question:'比较两组结果',
  method:'摘要仅说明比较两种鞋垫条件下正常行走的下肢关节运动学指标（髋、膝、踝屈伸角及峰值角速度），受试者人数、年龄、足型纳入标准、测试设备与统计方法均为缺项。',
  finding:'阶段差异',boundary:'摘要未说明样本数',sources:[evidence('abstract',1,'原文摘要'),
   evidence('other-version',2,'外部来源','version-b'),{...evidence('visual',1),kind:'page-image'}]};
 const restored=api.normalizeRecord(data,{sourceHash:'version-a'});
 assert.equal(restored.quickPurpose,data.quickPurpose);
 assert.deepEqual(plain(restored.quickReading.sources.map(source=>source.id)),['abstract']);
 assert.ok(!restored.quickReading.boundary);
 for (const record of [data,restored]) {
  const markdown=api.exportMarkdown(record,'论文');
  assert.match(markdown,/## 摘要快读.*基于原文摘要/);
  assert.match(markdown,/阅读目的：核对试验方法/);
  assert.match(markdown,/比较两种鞋垫条件下正常行走的下肢关节运动学指标（髋、膝、踝屈伸角及峰值角速度）/);
  assert.match(markdown,/原文摘要.*文件第 1 页/s);
  assert.doesNotMatch(markdown,/## 全文研读|外部来源|页面图像|适用边界|样本数|受试者人数|缺项/);
 }
 const {sourceHash,takeaway,finding,sources}=data.quickReading;
 const sparse=api.normalizeRecord({...data,quickReading:{sourceHash,takeaway,finding,sources}});
 assert.equal(sparse.quickReading.finding,finding);
 assert.doesNotMatch(api.exportMarkdown(sparse,'论文'),/研究问题|对象与方法|适用边界/);
 const bounded=api.normalizeRecord({...data,quickReading:{sourceHash,takeaway,finding,sources,boundary:'研究只比较正常行走时的关节运动学。'}});
 assert.match(api.exportMarkdown(bounded,'论文'),/适用边界.*只比较正常行走时的关节运动学/);
 assert.equal(api.normalizeRecord({...data,quickReading:{sourceHash,takeaway,sources}}).quickReading,null);
});

test('legacy evidence packing keeps every native block even when a former budget is supplied',()=>{
 const blocks=Array.from({length:100},(_,index)=>evidence(`block-${index}`,1+Math.floor(index/10),`第${index}段`+'材料'.repeat(150)));
 const pack=api.evidencePack(blocks,6500);
 assert.equal(pack.total,100,'source collection must not silently drop all blocks after the first 80');
 assert.equal(pack.sampled,false);
 assert.equal(pack.selected,100);
 const pages=[...new Set([...pack.map.values()].map(item=>item.page))];
 assert.ok(pages.includes(1)&&pages.includes(10),'complete input represents the beginning and end of the range');
 assert.equal(pack.evidence.map(item=>item.text).join(''),blocks.map(item=>item.text).join(''));
 assert.ok(pack.evidence.every(item=>/^E\d+$/.test(item.id)));
 assert.doesNotMatch(JSON.stringify(pack.evidence),/sourceHash|rects|pageLabel|desktopPath/);
});

test('nested full-document reading preserves more than 80 sources and long exact excerpts through reload and export',()=>{
 const long='完整原文，不得在持久化或导出时裁切。'.repeat(1400);
 const sources=Array.from({length:101},(_,index)=>evidence(`full-${index}`,index+1,index===100?long:`原文第${index+1}块`));
 const reading={title:'整篇研读',documentType:'论文',sources,summary:{body:'正文摘要',sources},
  sections:[{kind:'results',title:'结论',body:long,basis:'author',sources}],terms:[{term:'概念',explanation:long,sources}],
  quotes:[{quote:long,translation:'完整译文',sources}],related:[{title:'关联问题',body:long,sources}]};
 const normalized=api.normalizeReading(reading);
 assert.equal(normalized.sources.length,101);assert.equal(normalized.summary.sources.length,101);
 assert.equal(normalized.sections[0].sources[100].text,long);assert.equal(normalized.quotes[0].quote,long);
 const data=initial();data.preparations=[{key:'full',sourceHash:'version-a',status:'ready',start:1,end:101,reading:normalized}];
 const reloaded=api.normalizeRecord(data,{sourceHash:'version-a',numPages:101});
 assert.equal(reloaded.preparations[0].reading.summary.sources.length,101);
 assert.equal(reloaded.preparations[0].reading.sections[0].body,long);
 const markdown=api.exportMarkdown(reloaded,'全篇资料');
 assert.ok(markdown.includes(long));assert.match(markdown,/文件第 101 页/);assert.match(markdown,/正文摘要/);
});

test('source previews join only adjacent native lines and keep uncertain columns separate',()=>{
 const block=(id,item,y,text,status='native')=>({...evidence(id,2,text),itemStart:item,itemEnd:item+1,rects:[[40,y,200,y+10]],extractionStatus:status});
 const raw=[block('line-a',0,720,'The study used'),block('line-b',1,700,'a controlled comparison.'),{...block('other-column',2,700,'A separate column','needs_review'),rects:[[350,700,510,710]]},block('after-warning',3,680,'A different source')];
 const preview=api.previewSources(raw);
 assert.equal(preview.length,3);assert.equal(preview[0].text,'The study used\na controlled comparison.');
 assert.deepEqual(plain(preview[0].blockIds),['line-a','line-b']);assert.equal(preview[0].rects.length,2);
 assert.equal(preview[1].text,'A separate column');assert.equal(preview[1].extractionStatus,'needs_review');
 assert.equal(raw[0].text,'The study used','presentation grouping does not rewrite original persisted evidence');
 const multiword=[{...block('word-line',0,720,'The study used','needs_review'),rects:[[40,720,80,730],[90,720,200,730]]},block('next-line',1,700,'a controlled comparison.','needs_review')];
 assert.equal(api.previewSources(multiword).length,1,'same-column native lines join even on a page with a column warning');
});

test('candidate confirmation is transactional and idempotent; failed persistence never reports a saved card',async()=>{
 let fail=true;const writes=[];
 const store=api.createStore(initial(),async value=>{if(fail)throw new Error('disk full');writes.push(plain(value));});
 const candidate={key:'candidate-a',question:'为什么？',answer:'因为材料有限。',type:'边界',sourceHash:'version-a',sources:[evidence('block',3)],ai:true};
 await assert.rejects(store.transact(record=>api.addCard(record,candidate,{question:'我的问题',answer:'我的理解'})),/disk full/);
 assert.equal(store.state.cards.length,0);
 fail=false;
 await store.transact(record=>api.addCard(record,candidate,{question:'我的问题',answer:'我的理解'}));
 assert.equal(store.state.cards.length,1);assert.equal(store.state.cards[0].answer,'我的理解');
 await store.transact(record=>api.addCard(record,candidate,{question:'重复点击',answer:'不应覆盖'}));
 assert.equal(store.state.cards.length,1);assert.equal(store.state.cards[0].question,'我的问题');
 assert.equal(writes.at(-1).cards[0].sources[0].page,3);
});

test('queued writes preserve both independent edits and the latest UI draft',async()=>{
 const draft={draft:'尚未发送的问题'};let release;const waiting=new Promise(resolve=>{release=resolve;});let writes=0;
 const store=api.createStore(initial(),async()=>{writes+=1;if(writes===1)await waiting;},()=>draft);
 const first=store.transact(record=>record.notes.push({id:'note',text:'笔记',sources:[]}));
 await new Promise(resolve=>setImmediate(resolve));draft.draft='在保存时继续输入';
 const second=store.transact(record=>record.cards.push({id:'card',question:'问题',answer:'答案',sources:[]}));
 release();await Promise.all([first,second]);
 assert.equal(store.state.notes.length,1);assert.equal(store.state.cards.length,1);assert.equal(store.state.draft,'在保存时继续输入');
});

test('reloading pending work marks interruption and preserves old evidence for export',()=>{
 const data=initial();data.preparations=[{key:'old',sourceHash:'version-a',status:'preparing'}];data.messages=[{id:'q',question:'问题',status:'pending',sources:[]}];
 data.cards=[{id:'saved',question:'为什么？',answer:'我的已保存理解',sourceHash:'version-a',type:'概念',ai:true,sources:[evidence('old-source',3,'旧版原文','version-a')],reviews:[{at:1,rating:'仍需复习'}]}];
 const reloaded=api.normalizeRecord(data,{sourceHash:'version-b'});
 assert.equal(reloaded.preparations[0].status,'interrupted');assert.equal(reloaded.messages[0].status,'interrupted');
 assert.equal(reloaded.cards[0].sources[0].sourceHash,'version-a');
 const markdown=api.exportMarkdown(reloaded,'资料');
 assert.match(markdown,/旧版原文/);assert.match(markdown,/文件第 3 页/);assert.match(markdown,/来源版本 version-a/);assert.match(markdown,/AI 辅助，经我确认保留/);assert.match(markdown,/仍需复习/);
 assert.doesNotMatch(markdown,/上次任务已中断/,'incomplete conversation is not exported as an answer');
});

test('version 1 note drafts reopen and an editing draft retains its note identity and source',()=>{
 const legacy=api.normalizeRecord({version:1,noteDraft:'未保存的旧草稿',noteContext:{mode:'page',start:3,end:3,sourceHash:'version-a'}},{sourceHash:'version-a'});
 assert.equal(legacy.noteEditor,true);assert.equal(legacy.noteEditingId,null);assert.equal(legacy.noteContext.start,3);
 const editing=api.normalizeRecord({...legacy,noteEditingId:'saved-note',notes:[{id:'saved-note',text:'原笔记',sources:[evidence('source',3)]}]},{sourceHash:'version-b'});
 assert.equal(editing.noteEditingId,'saved-note');assert.equal(editing.noteDraft,'未保存的旧草稿');
 assert.equal(editing.notes[0].id,'saved-note');assert.equal(editing.notes[0].text,'原笔记');assert.equal(editing.notes[0].sources[0].sourceHash,'version-a');
 assert.equal(api.normalizeRecord(null,{sourceHash:'version-a'}).noteEditor,false);
});
