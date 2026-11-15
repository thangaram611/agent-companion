PRAGMA foreign_keys=OFF;
CREATE TABLE `session_v2` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `workspace_id` text,
          `parent_id` text,
          `fork_session_id` text,
          `fork_boundary` text,
          `slug` text NOT NULL,
          `directory` text NOT NULL,
          `path` text,
          `title` text,
          `version` text NOT NULL,
          `share_url` text,
          `summary_additions` integer,
          `summary_deletions` integer,
          `summary_files` integer,
          `summary_diffs` text,
          `metadata` text,
          `cost` real DEFAULT 0 NOT NULL,
          `tokens_input` integer DEFAULT 0 NOT NULL,
          `tokens_output` integer DEFAULT 0 NOT NULL,
          `tokens_reasoning` integer DEFAULT 0 NOT NULL,
          `tokens_cache_read` integer DEFAULT 0 NOT NULL,
          `tokens_cache_write` integer DEFAULT 0 NOT NULL,
          `revert` text,
          `permission` text,
          `agent` text,
          `model` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_busy` integer,
          `time_idle` integer,
          `time_viewed` integer,
          `idle_outcome` text,
          `time_compacting` integer,
          `time_archived` integer,
          `time_suspended` integer,
          `resume_attempts` integer DEFAULT 0 NOT NULL,
          CONSTRAINT `fk_session_v2_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
INSERT INTO session_v2 VALUES('ses_e229ce437ffeBST2EZW9xCg9Wa','a6e387d99b4aa5b096965213178cdafbeb6fb8c5',NULL,NULL,NULL,NULL,'hidden-river','/tmp/fixture/isolated/opencode/work','','Fixture command sequence','2.3.0',NULL,NULL,NULL,NULL,NULL,NULL,0.0,6268,1443,0,44928,0,NULL,NULL,NULL,'{"id":"__fixture_unknown_model__","providerID":"opencode"}',1794715622346,1794715644373,1794715644374,1794715644379,NULL,'failed',NULL,NULL,NULL,0);
CREATE TABLE `session_message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `type` text NOT NULL,
          `seq` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_session_message_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
INSERT INTO session_message VALUES('msg_1dd631bcc001WAnQdgwteuvSGi','ses_e229ce437ffeBST2EZW9xCg9Wa','model-switched',1,1794715622348,1794715622349,'{"time":{"created":1794715622348},"model":{"id":"flint-40b-free","providerID":"opencode"}}');
INSERT INTO session_message VALUES('msg_1dd631d06001TjpGP77MX3LCPs','ses_e229ce437ffeBST2EZW9xCg9Wa','user',5,1794715622832,1794715622832,'{"time":{"created":1794715622832},"text":"Run `echo FIXTURE-OK`, then run `ls /nonexistent-fixture-path`, then create notes.txt containing alpha, then change it to beta with your edit tool, then summarise in two sentences ending with DONE."}');
INSERT INTO session_message VALUES('msg_1dd631db6001kOxu2Rv7aE2sY1','ses_e229ce437ffeBST2EZW9xCg9Wa','assistant',6,1794715622840,1794715625288,'{"time":{"created":1794715622840,"firstToken":1794715623360,"streamed":1794715624731,"completed":1794715625287},"agent":"build","model":{"id":"flint-40b-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"The user gives a sequence of shell commands and edits. Let me just do it.\n\n1. Run `echo FIXTURE-OK`\n2. Run `ls /nonexistent-fixture-path`\n3. Create notes.txt containing alpha\n4. Change it to beta with edit tool\n5. Summarise in two sentences ending with DONE.\n\nLet me do steps 1-2 via shell in parallel? They''re independent but sequential shell calls fine. Then write notes.txt, then edit to beta, then final summary.\n\nLet me run echo and ls first.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794715623362,"completed":1794715624721}},{"type":"tool","id":"call_c3c957ad937946afb23bf8a7","name":"shell","executed":false,"state":{"status":"completed","input":{"command":"echo FIXTURE-OK"},"content":[{"type":"text","text":"FIXTURE-OK\n"}],"metadata":{"status":"completed","truncated":false,"exit":0}},"time":{"created":1794715624463,"ran":1794715624725,"completed":1794715625241}},{"type":"tool","id":"call_0ac5884a1b3d4a048940c899","name":"shell","executed":false,"state":{"status":"completed","input":{"command":"ls /nonexistent-fixture-path"},"content":[{"type":"text","text":"ls: /nonexistent-fixture-path: No such file or directory\n"},{"type":"text","text":"Exit code: 1"}],"metadata":{"status":"completed","truncated":false,"exit":1}},"time":{"created":1794715624587,"ran":1794715624729,"completed":1794715625286}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":5154,"output":143,"reasoning":0,"cache":{"read":0,"write":0}}}');
INSERT INTO session_message VALUES('msg_1dd63274b001NUlpX9FBQorKLR','ses_e229ce437ffeBST2EZW9xCg9Wa','assistant',20,1794715625292,1794715627038,'{"time":{"created":1794715625292,"firstToken":1794715626223,"streamed":1794715627035,"completed":1794715627038},"agent":"build","model":{"id":"flint-40b-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"Now create notes.txt containing alpha, then edit to beta.\n\nFind where notes.txt should be — likely current working directory. Let me write it there.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794715626225,"completed":1794715627033}},{"type":"text","text":"`echo FIXTURE-OK` ran fine, and `ls /nonexistent-fixture-path` correctly returned a not-found error.\n\nNow creating the file:"},{"type":"tool","id":"call_b237c4cff8fa46a9bb4326e6","name":"write","executed":false,"state":{"status":"completed","input":{"content":"alpha\n","path":"notes.txt"},"content":[{"type":"text","text":"Created file successfully: notes.txt"}],"metadata":{"truncated":false}},"time":{"created":1794715626410,"ran":1794715627034,"completed":1794715627037}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":81,"output":82,"reasoning":0,"cache":{"read":5248,"write":0}}}');
INSERT INTO session_message VALUES('msg_1dd632e210016wCVjxlM3kYIf9','ses_e229ce437ffeBST2EZW9xCg9Wa','assistant',32,1794715627043,1794715628304,'{"time":{"created":1794715627043,"firstToken":1794715628007,"streamed":1794715628295,"completed":1794715628303},"agent":"build","model":{"id":"flint-40b-free","providerID":"opencode","variant":"default"},"content":[{"type":"tool","id":"call_d76e30dec7a4495495b4a48e","name":"edit","executed":false,"state":{"status":"completed","input":{"path":"notes.txt","oldString":"alpha","newString":"beta","replaceAll":false},"content":[{"type":"text","text":"Edited notes.txt (1 replacement)"}],"metadata":{"files":[{"file":"notes.txt","patch":"Index: notes.txt\n===================================================================\n--- notes.txt\n+++ notes.txt\n@@ -1,1 +1,1 @@\n-alpha\n+beta\n","status":"modified","additions":1,"deletions":1}],"truncated":false}},"time":{"created":1794715628007,"ran":1794715628294,"completed":1794715628302}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":44,"output":32,"reasoning":0,"cache":{"read":5376,"write":0}}}');
INSERT INTO session_message VALUES('msg_1dd633315001ZF77iCLuNn9gqD','ses_e229ce437ffeBST2EZW9xCg9Wa','assistant',40,1794715628312,1794715629577,'{"time":{"created":1794715628312,"firstToken":1794715629144,"streamed":1794715629576,"completed":1794715629577},"agent":"build","model":{"id":"flint-40b-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"The file now contains \"beta\". The user asked to summarise in two sentences ending with DONE.\n\nWrite the summary now.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794715629145,"completed":1794715629574}},{"type":"text","text":"Done — the fix for the fixture flow is complete: `echo FIXTURE-OK` succeeded, the bad path lookup failed as expected, and I created `notes.txt` with alpha before switching it to beta. DONE."}],"finish":"stop","rawFinish":"stop","cost":0,"tokens":{"input":86,"output":72,"reasoning":0,"cache":{"read":5376,"write":0}}}');
INSERT INTO session_message VALUES('msg_1dd63380b001Ya3AHlkmmMrm0p','ses_e229ce437ffeBST2EZW9xCg9Wa','idle',48,1794715629579,1794715629579,'{"time":{"created":1794715629579},"outcome":"succeeded"}');
INSERT INTO session_message VALUES('msg_1dd63427e001ioTSEVfsJWQRPj','ses_e229ce437ffeBST2EZW9xCg9Wa','user',51,1794715632455,1794715632455,'{"time":{"created":1794715632455},"text":"Repeat the full fixture scenario now. Execute both commands separately, even though ls fails. Create or overwrite notes.txt with alpha using your file write tool, then change alpha to beta using your edit tool. Summarise in exactly two sentences ending with DONE. Do not skip tools based on prior work.\n\nRun `echo FIXTURE-OK`, then run `ls /nonexistent-fixture-path`, then create notes.txt containing alpha, then change it to beta with your edit tool, then summarise in two sentences ending with DONE."}');
INSERT INTO session_message VALUES('msg_1dd63434d001y55EukD5E1IcBi','ses_e229ce437ffeBST2EZW9xCg9Wa','assistant',52,1794715632463,1794715635623,'{"time":{"created":1794715632463,"firstToken":1794715633008,"streamed":1794715635441,"completed":1794715635623},"agent":"build","model":{"id":"flint-40b-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"The user asks to repeat the full fixture scenario. I should run echo and ls separately, then create/overwrite notes.txt with alpha via write, then edit alpha to beta, then summarise in exactly two sentences ending with DONE.\n\nNote: \"Execute both commands separately, even though ls fails\" — so run echo and ls as separate shell calls.\n\nLet me do the shell calls. They''re independent, can be parallel. But \"separately\" — I already did separately in prior turn. To be safe, run them again as separate tool calls.\n\nThen write notes.txt (overwrite with alpha), then edit to beta, then final summary of exactly two sentences ending with DONE.\n\nThe final summary must be exactly two sentences ending with DONE. Let me craft it.\n\nFirst run the commands.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794715633008,"completed":1794715635430}},{"type":"tool","id":"call_983260788b7f484c9b8efe29","name":"shell","executed":false,"state":{"status":"completed","input":{"command":"echo FIXTURE-OK"},"content":[{"type":"text","text":"FIXTURE-OK\n"}],"metadata":{"status":"completed","truncated":false,"exit":0}},"time":{"created":1794715635172,"ran":1794715635437,"completed":1794715635578}},{"type":"tool","id":"call_502999ea8e624d7ab115ac85","name":"shell","executed":false,"state":{"status":"completed","input":{"command":"ls /nonexistent-fixture-path"},"content":[{"type":"text","text":"ls: /nonexistent-fixture-path: No such file or directory\n"},{"type":"text","text":"Exit code: 1"}],"metadata":{"status":"completed","truncated":false,"exit":1}},"time":{"created":1794715635295,"ran":1794715635440,"completed":1794715635622}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":136,"output":187,"reasoning":0,"cache":{"read":5504,"write":0}}}');
INSERT INTO session_message VALUES('msg_1dd634faa001LCQI0Gwyy2eBSZ','ses_e229ce437ffeBST2EZW9xCg9Wa','assistant',66,1794715635627,1794715637466,'{"time":{"created":1794715635627,"firstToken":1794715637434,"streamed":1794715637461,"completed":1794715637465},"agent":"build","model":{"id":"flint-40b-free","providerID":"opencode","variant":"default"},"content":[{"type":"text","text":"Now recreating the notes file and updating it:"},{"type":"tool","id":"call_5801b5f9b57b440f9303a254","name":"write","executed":false,"state":{"status":"completed","input":{"content":"alpha\n","path":"notes.txt"},"content":[{"type":"text","text":"Wrote file successfully: notes.txt"}],"metadata":{"truncated":false}},"time":{"created":1794715637450,"ran":1794715637459,"completed":1794715637464}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":99,"output":27,"reasoning":0,"cache":{"read":5760,"write":0}}}');
INSERT INTO session_message VALUES('msg_1dd6356dd00186sSYM0s2wLvcZ','ses_e229ce437ffeBST2EZW9xCg9Wa','assistant',76,1794715637471,1794715638474,'{"time":{"created":1794715637471,"firstToken":1794715638003,"streamed":1794715638469,"completed":1794715638474},"agent":"build","model":{"id":"flint-40b-free","providerID":"opencode","variant":"default"},"content":[{"type":"tool","id":"call_6a1f1db066084751a210a398","name":"edit","executed":false,"state":{"status":"completed","input":{"path":"notes.txt","oldString":"alpha","newString":"beta","replaceAll":false},"content":[{"type":"text","text":"Edited notes.txt (1 replacement)"}],"metadata":{"files":[{"file":"notes.txt","patch":"Index: notes.txt\n===================================================================\n--- notes.txt\n+++ notes.txt\n@@ -1,1 +1,1 @@\n-alpha\n+beta\n","status":"modified","additions":1,"deletions":1}],"truncated":false}},"time":{"created":1794715638003,"ran":1794715638468,"completed":1794715638473}}],"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":136,"output":32,"reasoning":0,"cache":{"read":5760,"write":0}}}');
INSERT INTO session_message VALUES('msg_1dd635ace001gS5U14zOz2Fv4Q','ses_e229ce437ffeBST2EZW9xCg9Wa','assistant',84,1794715638480,1794715640069,'{"time":{"created":1794715638480,"firstToken":1794715639551,"streamed":1794715640068,"completed":1794715640069},"agent":"build","model":{"id":"flint-40b-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"Now summarise in exactly two sentences ending with DONE.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794715639552,"completed":1794715640066}},{"type":"text","text":"The full fixture scenario ran again from scratch: `echo FIXTURE-OK` printed successfully, and the subsequent `ls /nonexistent-fixture-path` reported its not-found error as expected. I then overwrote `notes.txt` with alpha, used the edit tool to change it to beta, and confirmed the final state. DONE."}],"finish":"stop","rawFinish":"stop","cost":0,"tokens":{"input":50,"output":81,"reasoning":0,"cache":{"read":5888,"write":0}}}');
INSERT INTO session_message VALUES('msg_1dd636106001tTs8riaf6uHrYq','ses_e229ce437ffeBST2EZW9xCg9Wa','idle',94,1794715640070,1794715640070,'{"time":{"created":1794715640070},"outcome":"succeeded"}');
INSERT INTO session_message VALUES('msg_1dd63636a001xKmcK6rHRQHwhS','ses_e229ce437ffeBST2EZW9xCg9Wa','user',97,1794715640888,1794715640889,'{"time":{"created":1794715640888},"text":"Reply with the word AGAIN."}');
INSERT INTO session_message VALUES('msg_1dd63643c0011Zyy1E0oSv0xAA','ses_e229ce437ffeBST2EZW9xCg9Wa','assistant',98,1794715640894,1794715641552,'{"time":{"created":1794715640894,"firstToken":1794715641428,"streamed":1794715641551,"completed":1794715641552},"agent":"build","model":{"id":"flint-40b-free","providerID":"opencode","variant":"default"},"content":[{"type":"reasoning","text":"The user asks to reply with the word AGAIN. Simple response.","native":{"reasoningField":"reasoning_content"},"time":{"created":1794715641429,"completed":1794715641549}},{"type":"text","text":"AGAIN"}],"finish":"stop","rawFinish":"stop","cost":0,"tokens":{"input":10,"output":18,"reasoning":0,"cache":{"read":6016,"write":0}}}');
INSERT INTO session_message VALUES('msg_1dd6366d1001Z0z8F2S1Vsbsi3','ses_e229ce437ffeBST2EZW9xCg9Wa','idle',106,1794715641553,1794715641554,'{"time":{"created":1794715641553},"outcome":"succeeded"}');
INSERT INTO session_message VALUES('msg_1dd6370fe0010Zz5aZDyvir6BI','ses_e229ce437ffeBST2EZW9xCg9Wa','model-switched',107,1794715644158,1794715644158,'{"time":{"created":1794715644158},"model":{"id":"__fixture_unknown_model__","providerID":"opencode"},"previous":{"id":"flint-40b-free","providerID":"opencode","variant":"default"}}');
INSERT INTO session_message VALUES('msg_1dd637115001oUMRXEV0oq57XP','ses_e229ce437ffeBST2EZW9xCg9Wa','user',110,1794715644377,1794715644378,'{"time":{"created":1794715644377},"text":"Reply with the word FAILURE."}');
INSERT INTO session_message VALUES('msg_1dd6371db00114Wt4MwnHk6Hpf','ses_e229ce437ffeBST2EZW9xCg9Wa','idle',111,1794715644379,1794715644379,'{"time":{"created":1794715644379},"outcome":"failed","error":{"type":"provider.no-route","message":"Model unavailable: opencode/__fixture_unknown_model__"}}');
CREATE TABLE "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
INSERT INTO migration VALUES('20260127222353_familiar_lady_ursula',1794715622324);
INSERT INTO migration VALUES('20260211171708_add_project_commands',1794715622324);
INSERT INTO migration VALUES('20260213144116_wakeful_the_professor',1794715622324);
INSERT INTO migration VALUES('20260225215848_workspace',1794715622324);
INSERT INTO migration VALUES('20260227213759_add_session_workspace_id',1794715622324);
INSERT INTO migration VALUES('20260228203230_blue_harpoon',1794715622324);
INSERT INTO migration VALUES('20260303231226_add_workspace_fields',1794715622324);
INSERT INTO migration VALUES('20260309230000_move_org_to_state',1794715622324);
INSERT INTO migration VALUES('20260312043431_session_message_cursor',1794715622324);
INSERT INTO migration VALUES('20260323234822_events',1794715622324);
INSERT INTO migration VALUES('20260410174513_workspace-name',1794715622324);
INSERT INTO migration VALUES('20260413175956_chief_energizer',1794715622324);
INSERT INTO migration VALUES('20260423070820_add_icon_url_override',1794715622324);
INSERT INTO migration VALUES('20260427172553_slow_nightmare',1794715622324);
INSERT INTO migration VALUES('20260428004200_add_session_path',1794715622324);
INSERT INTO migration VALUES('20260501142318_next_venus',1794715622324);
INSERT INTO migration VALUES('20260504145000_add_sync_owner',1794715622324);
INSERT INTO migration VALUES('20260507164347_add_workspace_time',1794715622324);
INSERT INTO migration VALUES('20260510033149_session_usage',1794715622324);
INSERT INTO migration VALUES('20260511000411_data_migration_state',1794715622324);
INSERT INTO migration VALUES('20260511173437_session-metadata',1794715622324);
INSERT INTO migration VALUES('20260601010001_normalize_storage_paths',1794715622324);
INSERT INTO migration VALUES('20260601202201_amazing_prowler',1794715622324);
INSERT INTO migration VALUES('20260602002951_lowly_union_jack',1794715622324);
INSERT INTO migration VALUES('20260602182828_add_project_directories',1794715622324);
INSERT INTO migration VALUES('20260603001617_session_message_projection_indexes',1794715622324);
INSERT INTO migration VALUES('20260603040000_session_message_projection_order',1794715622324);
INSERT INTO migration VALUES('20260603141458_session_input_inbox',1794715622324);
INSERT INTO migration VALUES('20260603160727_jittery_ezekiel_stane',1794715622324);
INSERT INTO migration VALUES('20260604172448_event_sourced_session_input',1794715622324);
INSERT INTO migration VALUES('20260605003541_add_session_context_snapshot',1794715622324);
INSERT INTO migration VALUES('20260605042240_add_context_epoch_agent',1794715622324);
INSERT INTO migration VALUES('20260611035744_credential',1794715622324);
INSERT INTO migration VALUES('20260611192811_lush_chimera',1794715622324);
INSERT INTO migration VALUES('20260612174303_project_dir_strategy',1794715622324);
INSERT INTO migration VALUES('20260622142730_simplify_session_context_epoch',1794715622324);
INSERT INTO migration VALUES('20260622170816_reset_v2_session_state',1794715622324);
INSERT INTO migration VALUES('20260622202450_simplify_session_input',1794715622324);
INSERT INTO migration VALUES('20260804233008_loose_psylocke',1794715622324);
INSERT INTO migration VALUES('20260805200742_import_legacy_credentials',1794715622324);
INSERT INTO migration VALUES('20260808023530_workspace_domain',1794715622324);
INSERT INTO migration VALUES('20260811161259_execution_claim_attempts',1794715622324);
INSERT INTO migration VALUES('20260812181746_session_inbox',1794715622324);
INSERT INTO migration VALUES('20260812213948_worktree',1794715622324);
INSERT INTO migration VALUES('20260819222447_session_viewed_state',1794715622324);
INSERT INTO migration VALUES('20260823191254_nullable_workspace_binding',1794715622324);
INSERT INTO migration VALUES('20260910120000_clear_v1_session_permission',1794715622324);
INSERT INTO migration VALUES('20260923013825_project_time_active',1794715622324);
INSERT INTO migration VALUES('20261007190000_azure_cli_external_credential',1794715622324);
INSERT INTO migration VALUES('20261010180456_project_time_archived',1794715622324);
INSERT INTO migration VALUES('20261024002554_session_allowance',1794715622324);
INSERT INTO migration VALUES('20261024175301_drop_session_allowance',1794715622324);
INSERT INTO migration VALUES('20261025123711_blob',1794715622324);
INSERT INTO migration VALUES('20261025154125_drop_session_pending',1794715622324);
INSERT INTO migration VALUES('20261026223005_schedule',1794715622324);
INSERT INTO migration VALUES('20261029002625_session_part',1794715622324);
INSERT INTO migration VALUES('20261029073502_session_time_busy',1794715622324);
INSERT INTO migration VALUES('20261029165540_schedule_checks',1794715622324);
INSERT INTO migration VALUES('20261030054400_job',1794715622324);
