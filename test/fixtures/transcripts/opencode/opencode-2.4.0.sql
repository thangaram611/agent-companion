PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
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
INSERT INTO session_v2 VALUES('ses_df64530ceffeIFq2vBPQYgbAiW','4bfad18cf7601d6c70e2d912e6ccaea62d263e30',NULL,NULL,NULL,NULL,'tidy-mountain','/tmp/oc-fixture/work','','sleep 170 foreground run','2.4.0',NULL,NULL,NULL,NULL,NULL,NULL,0.0,7751,457,0,6171,0,NULL,NULL,NULL,'{"id":"gpt-oss:20b","providerID":"ollama"}',1795459567411,1795459753132,1795459567687,1795459753136,NULL,'succeeded',NULL,NULL,NULL,0);
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
INSERT INTO session_message VALUES('msg_209bacf35001ePzVjKxn3sqDpw','ses_df64530ceffeIFq2vBPQYgbAiW','model-switched',1,1795459567413,1795459567414,'{"time":{"created":1795459567413},"model":{"id":"gpt-oss:20b","providerID":"ollama"}}');
INSERT INTO session_message VALUES('msg_209bacf5100135WFLoaevPLqIo','ses_df64530ceffeIFq2vBPQYgbAiW','user',5,1795459567693,1795459567693,'{"time":{"created":1795459567693},"text":"Use the shell to run sleep 170 in the foreground. After it exits reply OC-LONG."}');
INSERT INTO session_message VALUES('msg_209bad055001pxjN521HeZwcTF','ses_df64530ceffeIFq2vBPQYgbAiW','assistant',8,1795459567704,1795459746284,'{"time":{"created":1795459567704,"firstToken":1795459571319,"streamed":1795459575804,"completed":1795459746283},"agent":"build","model":{"id":"gpt-oss:20b","providerID":"ollama","variant":"default"},"content":[],"finish":"tool-calls","rawFinish":"tool_calls","cost":0,"tokens":{"input":528,"output":273,"reasoning":0,"cache":{"read":6030,"write":0}}}');
INSERT INTO session_message VALUES('msg_209bd89f5001Je4dfDvxWKlC7K','ses_df64530ceffeIFq2vBPQYgbAiW','assistant',18,1795459746296,1795459753133,'{"time":{"created":1795459746296,"firstToken":1795459753078,"streamed":1795459753131,"completed":1795459753132},"agent":"build","model":{"id":"gpt-oss:20b","providerID":"ollama","variant":"default"},"content":[],"finish":"stop","rawFinish":"stop","cost":0,"tokens":{"input":6844,"output":7,"reasoning":0,"cache":{"read":0,"write":0}}}');
INSERT INTO session_message VALUES('msg_209bda4b0001orGaum1fLAuYJQ','ses_df64530ceffeIFq2vBPQYgbAiW','idle',24,1795459753136,1795459753137,'{"time":{"created":1795459753136},"outcome":"succeeded"}');
CREATE TABLE `session_part` (
          `message_id` text NOT NULL,
          `session_id` text NOT NULL,
          `ordinal` integer NOT NULL,
          `type` text NOT NULL,
          `call_id` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `session_part_pk` PRIMARY KEY(`message_id`, `ordinal`),
          CONSTRAINT `fk_session_part_message_id_session_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `session_message`(`id`) ON DELETE CASCADE,
          CONSTRAINT `fk_session_part_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
INSERT INTO session_part VALUES('msg_209bad055001pxjN521HeZwcTF','ses_df64530ceffeIFq2vBPQYgbAiW',0,'reasoning',NULL,1795459571320,1795459575802,'{"type":"reasoning","text":"The user wants to run sleep 170 in foreground, then after it exits reply OC-LONG. We can use shell tool. It''s a foreground command; the tool''s background param default false. We need to run `sleep 170` which takes 170 seconds (~2.8 minutes). This is long. According to instructions, we shouldn''t do long-running tasks in interactive? The user explicitly wants to run sleep 170. Probably we should run it in the background? The instructions say: \"run sleep 170 in the foreground.\" That means the agent should wait until it completes. But that''s long. We can try to do it. But it''s okay? The user wants that. We can call shell with command ''sleep 170''. We''ll then reply OC-LONG after it exits. The shell tool will run and return output once done. We''ll then respond. There''s no output from sleep. So after we get result, reply OC-LONG. Let''s do it.","native":{"reasoningField":"reasoning"},"time":{"created":1795459571320,"completed":1795459575802}}');
INSERT INTO session_part VALUES('msg_209bad055001pxjN521HeZwcTF','ses_df64530ceffeIFq2vBPQYgbAiW',1,'tool','call_oslvadhw',1795459575800,1795459746277,'{"type":"tool","id":"call_oslvadhw","name":"shell","executed":false,"state":{"status":"completed","input":{"command":"sleep 170","background":false,"timeout":180000,"workdir":"/tmp/oc-fixture/work"},"content":[{"type":"text","text":"(no output)"}],"metadata":{"status":"completed","truncated":false,"exit":0}},"time":{"created":1795459575800,"ran":1795459575803,"completed":1795459746277}}');
INSERT INTO session_part VALUES('msg_209bd89f5001Je4dfDvxWKlC7K','ses_df64530ceffeIFq2vBPQYgbAiW',0,'text',NULL,1795459753079,1795459753129,'{"type":"text","text":"OC-LONG"}');
CREATE TABLE IF NOT EXISTS "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
INSERT INTO migration VALUES('20261120004954_machine-key',1795459338884);
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);
COMMIT;
