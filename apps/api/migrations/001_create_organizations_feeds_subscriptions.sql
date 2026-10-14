-- 001: The core catalog.
--
-- organizations  = our customers (trading firms). Each one is a "tenant".
-- feeds          = market data products Nimbus sells (one per exchange feed).
-- subscriptions  = which organization pays for which feed.
--
-- Users, roles and memberships arrive in Phase 5 (auth + multi-tenancy).

CREATE TABLE organizations (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text        NOT NULL UNIQUE,   -- URL-friendly id, e.g. 'granite-peak'
    name        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feeds (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    code         text        NOT NULL UNIQUE,  -- short stable identifier, e.g. 'NYSE-INT'
    name         text        NOT NULL,
    venue        text        NOT NULL,         -- the exchange the data comes from
    asset_class  text        NOT NULL
                 CHECK (asset_class IN ('equities', 'options', 'futures', 'fx')),
    region       text        NOT NULL
                 CHECK (region IN ('NA', 'EMEA', 'APAC')),
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
    organization_id  uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    feed_id          uuid        NOT NULL REFERENCES feeds (id) ON DELETE RESTRICT,
    -- 'direct' = raw exchange feed (fastest, priciest);
    -- 'consolidated' = normalized multi-venue feed (simpler, a bit slower).
    delivery         text        NOT NULL DEFAULT 'direct'
                     CHECK (delivery IN ('direct', 'consolidated')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, feed_id)
);

-- The composite primary key already indexes lookups by organization_id
-- (its first column). This index covers the reverse: "who subscribes to feed X?"
CREATE INDEX subscriptions_feed_id_idx ON subscriptions (feed_id);
