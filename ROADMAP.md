# Nimbus Roadmap: Beyond the Base Plan

The core phases (1–8) live in the [README](README.md#roadmap). This file tracks everything else:
nice-to-have features and learning goals. No deadlines; this project is about the learning.

**Current plan:** finish through Phase 5 ("quick path"), then evaluate what comes next.

## Housekeeping

- [ ] **After Phase 3:** update the README's "Project structure" diagram (add `apps/simulator`,
      `docs/phase-2-walkthrough.md`, and the current `web/src` files).

## Nice to have

- [ ] **SNS/SQS feature.** Only if it can run locally and for free (see LocalStack below) and has
      a real purpose in the app. Not part of the base plan.
- [ ] **AI support helper.** Answers questions from the app's docs/FAQs (says so instead of
      guessing) and helps users self-troubleshoot before submitting a ticket. Goal: fewer tickets.
      Related to, but broader than, the Phase 8 "Explain this alert" assistant.

## Learning: Infrastructure as Code

Unlike the rest of the project, **I write the Terraform myself** (Claude explains, I type), so it
counts as my own hands-on IaC experience.

- [ ] **Terraform + Docker provider (free, local).** Provision the local stack with Terraform
      instead of Docker Compose: network, Postgres, Redis, API, simulator. Learn providers,
      resources, variables/outputs, state, `plan` / `apply` / `destroy`, and modules.
- [ ] **LocalStack (free for non-commercial use, needs an account + auth token).** Point the AWS
      provider at emulated AWS to practice AWS-style Terraform (S3, SQS/SNS, IAM). Pairs with the
      SNS/SQS feature above. Check which services the free plan covers.
- [ ] **Optional finale: one real AWS deploy.** Overlaps with Phase 7's "optional deployment."
      Budget alert first, smallest instances, no NAT gateway; apply → test → destroy the same day.
- [ ] **Optional: `terraform plan` in GitHub Actions.** Ties into Phase 7 CI.
