resource "google_pubsub_topic" "dead_letter" {
  for_each = toset(local.pubsub_topics)

  name         = "${replace(each.value, ".", "-")}-dead-letter"
  kms_key_name = google_kms_crypto_key.storage.id

  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }

  depends_on = [google_kms_crypto_key_iam_member.storage_key_service_agents]
}

resource "google_pubsub_topic" "events" {
  for_each = toset(local.pubsub_topics)

  name         = replace(each.value, ".", "-")
  kms_key_name = google_kms_crypto_key.storage.id

  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }

  depends_on = [google_kms_crypto_key_iam_member.storage_key_service_agents]
}

resource "google_pubsub_subscription" "dead_letter_keep" {
  for_each = toset(local.pubsub_topics)

  name                       = "${replace(each.value, ".", "-")}-dead-letter-keep"
  topic                      = google_pubsub_topic.dead_letter[each.value].id
  message_retention_duration = "604800s"
  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_subscription" "push" {
  for_each = local.pubsub_subscriptions

  name                       = replace(each.key, ".", "-")
  topic                      = google_pubsub_topic.events[each.value.topic].id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.svc[each.value.subscriber].uri}${each.value.path}"

    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = google_cloud_run_v2_service.svc[each.value.subscriber].uri
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter[each.value.topic].id
    max_delivery_attempts = var.pubsub_max_delivery_attempts
  }

  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  for_each = toset(local.pubsub_topics)

  topic  = google_pubsub_topic.dead_letter[each.value].id
  role   = "roles/pubsub.publisher"
  member = local.cmek_service_agents.pubsub
}

resource "google_pubsub_subscription_iam_member" "dead_letter_subscriber" {
  for_each = local.pubsub_subscriptions

  subscription = google_pubsub_subscription.push[each.key].id
  role         = "roles/pubsub.subscriber"
  member       = local.cmek_service_agents.pubsub
}

resource "google_cloud_run_v2_service_iam_member" "pubsub_push_invoker" {
  for_each = toset(distinct([for s in values(local.pubsub_subscriptions) : s.subscriber]))

  name     = google_cloud_run_v2_service.svc[each.value].name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_service_account.pubsub_push.member
}
