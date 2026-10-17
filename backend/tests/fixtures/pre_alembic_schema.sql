CREATE TABLE ai_categories (
	id INTEGER NOT NULL,
	name VARCHAR NOT NULL,
	blurb VARCHAR,
	embedding BLOB NOT NULL,
	dim INTEGER NOT NULL,
	model VARCHAR NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id)
);

CREATE TABLE ai_jobs (
	id INTEGER NOT NULL,
	kind VARCHAR(19) NOT NULL,
	video_id INTEGER,
	catalog_video_id INTEGER,
	status VARCHAR(9) NOT NULL,
	attempts INTEGER NOT NULL,
	run_after DATETIME,
	error VARCHAR,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(video_id) REFERENCES videos (id),
	FOREIGN KEY(catalog_video_id) REFERENCES channel_catalog_videos (id)
);

CREATE TABLE channel_autodownloads (
	id INTEGER NOT NULL,
	channel_url VARCHAR NOT NULL,
	channel_name VARCHAR,
	enabled BOOLEAN NOT NULL,
	previous_mode VARCHAR NOT NULL,
	previous_count INTEGER,
	quality_preset VARCHAR NOT NULL,
	include_completed_streams BOOLEAN NOT NULL,
	anchor_ready BOOLEAN NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id)
);

CREATE TABLE channel_catalog_embeddings (
	id INTEGER NOT NULL,
	catalog_video_id INTEGER NOT NULL,
	model VARCHAR NOT NULL,
	dim INTEGER NOT NULL,
	vector BLOB NOT NULL,
	content_hash VARCHAR NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(catalog_video_id) REFERENCES channel_catalog_videos (id)
);

CREATE TABLE channel_catalog_skips (
	id INTEGER NOT NULL,
	catalog_id INTEGER NOT NULL,
	yt_id VARCHAR NOT NULL,
	reason VARCHAR NOT NULL,
	skipped_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (catalog_id, yt_id),
	FOREIGN KEY(catalog_id) REFERENCES channel_catalogs (id)
);

CREATE TABLE channel_catalog_videos (
	id INTEGER NOT NULL,
	catalog_id INTEGER NOT NULL,
	yt_id VARCHAR NOT NULL,
	url VARCHAR NOT NULL,
	title VARCHAR,
	duration FLOAT,
	view_count INTEGER,
	published_at VARCHAR,
	thumbnail_url VARCHAR,
	description VARCHAR,
	live_status VARCHAR,
	position INTEGER NOT NULL,
	indexed_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (catalog_id, yt_id),
	FOREIGN KEY(catalog_id) REFERENCES channel_catalogs (id)
);

CREATE TABLE channel_catalogs (
	id INTEGER NOT NULL,
	channel_url VARCHAR NOT NULL,
	channel_name VARCHAR,
	status VARCHAR(8) NOT NULL,
	indexed_count INTEGER NOT NULL,
	channel_total INTEGER,
	complete BOOLEAN NOT NULL,
	max_videos INTEGER NOT NULL,
	direct_youtube_search BOOLEAN,
	phase VARCHAR,
	last_error VARCHAR,
	started_at DATETIME,
	finished_at DATETIME,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id)
);

CREATE TABLE download_jobs (
	id INTEGER NOT NULL,
	url VARCHAR NOT NULL,
	quality_preset VARCHAR NOT NULL,
	available_presets_json VARCHAR,
	status VARCHAR(11) NOT NULL,
	progress FLOAT NOT NULL,
	title VARCHAR,
	title_override VARCHAR,
	channel VARCHAR,
	channel_override VARCHAR,
	thumbnail_url VARCHAR,
	notes_pending VARCHAR,
	paused BOOLEAN NOT NULL,
	normalize_volume BOOLEAN NOT NULL,
	video_codec VARCHAR NOT NULL,
	destination VARCHAR NOT NULL,
	device_file_path VARCHAR,
	replace_video_id INTEGER,
	playlist_id INTEGER,
	error VARCHAR,
	error_kind VARCHAR,
	video_id INTEGER,
	file_size INTEGER,
	height_px INTEGER,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(replace_video_id) REFERENCES videos (id),
	FOREIGN KEY(video_id) REFERENCES videos (id)
);

CREATE TABLE openrouter_usage (
	id INTEGER NOT NULL,
	kind VARCHAR NOT NULL,
	cost FLOAT NOT NULL,
	model VARCHAR,
	video_id INTEGER,
	prompt_tokens INTEGER,
	completion_tokens INTEGER,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id)
);

CREATE TABLE playlist_items (
	id INTEGER NOT NULL,
	playlist_id INTEGER NOT NULL,
	video_id INTEGER NOT NULL,
	position INTEGER NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(playlist_id) REFERENCES playlists (id),
	FOREIGN KEY(video_id) REFERENCES videos (id)
);

CREATE TABLE playlists (
	id INTEGER NOT NULL,
	name VARCHAR NOT NULL,
	description VARCHAR,
	source_type VARCHAR(7) NOT NULL,
	source_url VARCHAR,
	subscribed BOOLEAN NOT NULL,
	quality_preset VARCHAR,
	last_synced_at DATETIME,
	sync_error VARCHAR,
	position INTEGER NOT NULL,
	cover_video_id INTEGER,
	cover_path VARCHAR,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id)
);

CREATE TABLE video_ai_chat (
	video_id INTEGER NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (video_id),
	FOREIGN KEY(video_id) REFERENCES videos (id)
);

CREATE TABLE video_ai_chat_messages (
	id INTEGER NOT NULL,
	video_id INTEGER NOT NULL,
	role VARCHAR NOT NULL,
	content VARCHAR NOT NULL,
	cost FLOAT,
	model VARCHAR,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(video_id) REFERENCES videos (id)
);

CREATE TABLE video_ai_meta (
	video_id INTEGER NOT NULL,
	embed_status VARCHAR NOT NULL,
	content_hash VARCHAR NOT NULL,
	summary VARCHAR,
	summary_length VARCHAR,
	summary_cost FLOAT,
	summary_model VARCHAR,
	ai_tags VARCHAR NOT NULL,
	user_tags VARCHAR NOT NULL,
	tags_enriched_at DATETIME,
	tags_locked BOOLEAN NOT NULL,
	embed_error VARCHAR,
	chapters VARCHAR,
	chapters_skip_reason VARCHAR,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (video_id),
	FOREIGN KEY(video_id) REFERENCES videos (id)
);

CREATE TABLE video_embeddings (
	id INTEGER NOT NULL,
	video_id INTEGER NOT NULL,
	chunk_index INTEGER NOT NULL,
	model VARCHAR NOT NULL,
	dim INTEGER NOT NULL,
	vector BLOB NOT NULL,
	content_hash VARCHAR NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(video_id) REFERENCES videos (id)
);

CREATE TABLE videos (
	id INTEGER NOT NULL,
	title VARCHAR NOT NULL,
	channel VARCHAR,
	channel_url VARCHAR,
	tags VARCHAR NOT NULL,
	description VARCHAR,
	notes VARCHAR,
	source_url VARCHAR,
	thumbnail_path VARCHAR,
	sprite_path VARCHAR,
	subtitles VARCHAR NOT NULL,
	file_path VARCHAR NOT NULL,
	duration_sec FLOAT,
	file_size INTEGER,
	width_px INTEGER,
	height_px INTEGER,
	view_count INTEGER,
	channel_subscriber_count INTEGER,
	published_at DATETIME,
	added_at DATETIME NOT NULL,
	last_position_sec FLOAT NOT NULL,
	last_watched_at DATETIME,
	needs_review BOOLEAN NOT NULL,
	platform VARCHAR,
	status VARCHAR(11) NOT NULL,
	frame_rate FLOAT,
	metadata_synced_at DATETIME,
	source_title VARCHAR,
	source_description VARCHAR,
	title_is_custom BOOLEAN NOT NULL,
	description_is_custom BOOLEAN NOT NULL,
	subtitles_pending BOOLEAN NOT NULL,
	subtitles_retry_after DATETIME,
	subtitles_fetch_attempts INTEGER NOT NULL,
	source_chapters VARCHAR NOT NULL,
	vcodec VARCHAR,
	acodec VARCHAR,
	codec_string VARCHAR,
	bit_depth INTEGER,
	is_hdr BOOLEAN NOT NULL,
	media_probed_at DATETIME,
	compat_path VARCHAR,
	compat_size INTEGER,
	compat_source VARCHAR,
	compat_error VARCHAR,
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_ai_categories_name ON ai_categories (name);

CREATE INDEX ix_ai_jobs_catalog_video_id ON ai_jobs (catalog_video_id);

CREATE INDEX ix_ai_jobs_kind ON ai_jobs (kind);

CREATE INDEX ix_ai_jobs_run_after ON ai_jobs (run_after);

CREATE INDEX ix_ai_jobs_status ON ai_jobs (status);

CREATE INDEX ix_ai_jobs_video_id ON ai_jobs (video_id);

CREATE UNIQUE INDEX ix_channel_autodownloads_channel_url ON channel_autodownloads (channel_url);

CREATE INDEX ix_channel_autodownloads_enabled ON channel_autodownloads (enabled);

CREATE UNIQUE INDEX ix_channel_catalog_embeddings_catalog_video_id ON channel_catalog_embeddings (catalog_video_id);

CREATE INDEX ix_channel_catalog_skips_catalog_id ON channel_catalog_skips (catalog_id);

CREATE INDEX ix_channel_catalog_skips_yt_id ON channel_catalog_skips (yt_id);

CREATE INDEX ix_channel_catalog_videos_catalog_id ON channel_catalog_videos (catalog_id);

CREATE INDEX ix_channel_catalog_videos_position ON channel_catalog_videos (position);

CREATE INDEX ix_channel_catalog_videos_yt_id ON channel_catalog_videos (yt_id);

CREATE INDEX ix_channel_catalogs_channel_name ON channel_catalogs (channel_name);

CREATE UNIQUE INDEX ix_channel_catalogs_channel_url ON channel_catalogs (channel_url);

CREATE INDEX ix_channel_catalogs_status ON channel_catalogs (status);

CREATE INDEX ix_download_jobs_playlist_id ON download_jobs (playlist_id);

CREATE INDEX ix_openrouter_usage_created_at ON openrouter_usage (created_at);

CREATE INDEX ix_openrouter_usage_kind ON openrouter_usage (kind);

CREATE INDEX ix_openrouter_usage_video_id ON openrouter_usage (video_id);

CREATE INDEX ix_playlist_items_playlist_id ON playlist_items (playlist_id);

CREATE INDEX ix_playlist_items_video_id ON playlist_items (video_id);

CREATE INDEX ix_playlists_created_at ON playlists (created_at);

CREATE INDEX ix_playlists_position ON playlists (position);

CREATE INDEX ix_video_ai_chat_messages_role ON video_ai_chat_messages (role);

CREATE INDEX ix_video_ai_chat_messages_video_id ON video_ai_chat_messages (video_id);

CREATE INDEX ix_video_ai_meta_embed_status ON video_ai_meta (embed_status);

CREATE INDEX ix_video_embeddings_chunk_index ON video_embeddings (chunk_index);

CREATE INDEX ix_video_embeddings_video_id ON video_embeddings (video_id);

CREATE INDEX ix_videos_added_at ON videos (added_at);

CREATE INDEX ix_videos_channel ON videos (channel);

CREATE UNIQUE INDEX ix_videos_file_path ON videos (file_path);

CREATE INDEX ix_videos_needs_review ON videos (needs_review);

CREATE INDEX ix_videos_subtitles_pending ON videos (subtitles_pending);

CREATE INDEX ix_videos_title ON videos (title);

