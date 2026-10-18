# Checks that .github/workflows agree with this module and keep the security
# rules of a public repository with id-token: write. Offline: `terraform test`.
# Runs use production (var.environment's default) unless they set staging.

mock_provider "google" {}
mock_provider "google-beta" {}

variables {
  project_id   = "onboardai-test-123"
  alert_emails = ["alerts-a@example.com"]
}

# terraform test runs in whichever workspace is selected; the guard is tested
# on its own in tests/state_guard.tftest.hcl.
override_module {
  target = module.state_guard
}

# Well-formed stand-ins for the apply run below: the provider validates service
# account names, and the config job checks the deployer's email.
override_resource {
  target = google_service_account.checklist_agent[0]
  values = {
    email = "onboardai-checklist@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-checklist@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.deployer
  values = {
    email = "onboardai-deployer@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-deployer@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.runtime
  values = {
    email = "onboardai-api-run@onboardai-test-123.iam.gserviceaccount.com"
    name  = "projects/onboardai-test-123/serviceAccounts/onboardai-api-run@onboardai-test-123.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_iam_workload_identity_pool_provider.github
  values = {
    name = "projects/123456789012/locations/global/workloadIdentityPools/onboardai-github/providers/github-actions"
  }
}

run "deploy_flags_match_terraform" {
  command = plan

  # deploy.yml passes these exact strings to gcloud run deploy; Terraform uses the
  # same locals for the services. If they differ, an apply and a deploy undo
  # each other.
  assert {
    condition = alltrue([
      for key, flags in output.cloud_run_deploy_flags :
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "      ${upper(key)}_RUN_FLAGS: ${flags}\n")
    ])
    error_message = "WEB_/API_/TTS_RUN_FLAGS in .github/workflows/deploy.yml must equal `terraform output cloud_run_deploy_flags`."
  }

  assert {
    condition     = length(regexall("(?m)^\\s+[A-Z]+_RUN_FLAGS:", file("${path.module}/../../.github/workflows/deploy.yml"))) == 3
    error_message = "deploy.yml must define exactly the three *_RUN_FLAGS lines."
  }

  # Gemini runs on Vertex AI as onboardai-api-run: no API key. Since #45 the
  # api is deployed once, in every stack, with its Cloud SQL connection and
  # DATABASE_URL as a Secret Manager reference; INTAKE_MCP_TOKEN and the
  # engine are added only when the agent job deployed the intake agent on
  # staging. --set-secrets replaces every reference an earlier revision
  # carried, so production no longer needs --clear-secrets.
  assert {
    condition = (
      !strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "GEMINI_SECRET") &&
      !strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "GEMINI_API_KEY=") &&
      !strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "secret_flags") &&
      !strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "--update-secrets") &&
      !strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "--clear-secrets") &&
      length(regexall("--set-secrets=", file("${path.module}/../../.github/workflows/deploy.yml"))) == 1 &&
      length(regexall("--set-cloudsql-instances=", file("${path.module}/../../.github/workflows/deploy.yml"))) == 1 &&
      length(regexall("deploy api ", file("${path.module}/../../.github/workflows/deploy.yml"))) == 1 &&
      can(regex("          api_secrets=\"DATABASE_URL=onboardai-database-url\\$NAME_SUFFIX:latest\"\\n(?:          #[^\\n]*\\n)*          if \\[\\[ \"\\$DEPLOY_ENV\" == staging && \"\\$INTAKE_AGENT_DEPLOYED\" == true \\]\\]; then\\n            if \\[\\[ ! \"\\$INTAKE_AGENT_ENGINE\" =~ [^\\n]+\\n[^\\n]+\\n[^\\n]+\\n            fi\\n            api_env\\+=\",INTAKE_AGENT_ENGINE=\\$INTAKE_AGENT_ENGINE\"\\n            api_secrets\\+=\",INTAKE_MCP_TOKEN=onboardai-intake-mcp-token\\$NAME_SUFFIX:latest\"\\n            echo \"intake_agent=true\" >> \"\\$GITHUB_OUTPUT\"\\n          else\\n            echo \"intake_agent=false\" >> \"\\$GITHUB_OUTPUT\"\\n          fi\\n          deploy api \"\\$api_env\" \\\\\\n            --set-cloudsql-instances=\"\\$GCP_PROJECT_ID:\\$GCP_REGION:onboardai-db\\$NAME_SUFFIX\" \\\\\\n            --set-secrets=\"\\$api_secrets\"\\n", file("${path.module}/../../.github/workflows/deploy.yml")))
    )
    error_message = "The api is deployed once in every stack with --set-cloudsql-instances onboardai-db$NAME_SUFFIX and --set-secrets DATABASE_URL; INTAKE_MCP_TOKEN and INTAKE_AGENT_ENGINE are added only on staging when the agent job deployed the agent. No --clear-secrets."
  }

  assert {
    condition = (
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "GOOGLE_CLOUD_PROJECT=$GCP_PROJECT_ID,") &&
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "GOOGLE_CLOUD_LOCATION=$VERTEX_LOCATION,") &&
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "\n  VERTEX_LOCATION: global\n")
    )
    error_message = "The api env must carry GOOGLE_CLOUD_PROJECT=$GCP_PROJECT_ID and GOOGLE_CLOUD_LOCATION (VERTEX_LOCATION, global)."
  }

  assert {
    condition = (
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "AI_MODE=$AI_MODE,GEMINI_MODEL=$GEMINI_MODEL,") &&
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), ",VERTEX_SEARCH_LOCATION=$VERTEX_SEARCH_LOCATION,VERTEX_SEARCH_ENGINE_ID=$VERTEX_SEARCH_ENGINE_ID,FIRESTORE_DATABASE_ID=$FIRESTORE_DATABASE_ID,") &&
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "DOCS_BUCKET=$GCP_PROJECT_ID-onboardai-docs$NAME_SUFFIX,VERTEX_SEARCH_DATA_STORE_ID=onboardai-docs$NAME_SUFFIX,EMPLOYEE_DOCUMENTS_BUCKET=$GCP_PROJECT_ID-onboardai-employee-docs$NAME_SUFFIX,") &&
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "TTS_SERVICE_URL=$tts_url\"")
    )
    error_message = "The api env (contract v2) must carry AI_MODE, GEMINI_MODEL, VERTEX_SEARCH_LOCATION, VERTEX_SEARCH_ENGINE_ID, FIRESTORE_DATABASE_ID, DOCS_BUCKET, VERTEX_SEARCH_DATA_STORE_ID, EMPLOYEE_DOCUMENTS_BUCKET and TTS_SERVICE_URL."
  }

  # The deploy job takes the three contract v2 values from the repository
  # variables of the same names.
  assert {
    condition = alltrue([
      for name in ["VERTEX_SEARCH_LOCATION", "VERTEX_SEARCH_ENGINE_ID", "FIRESTORE_DATABASE_ID"] :
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.env[name] == "$${{ vars.${name} }}" &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.config.env[name] == "$${{ vars.${name} }}"
    ])
    error_message = "deploy and config must read VERTEX_SEARCH_LOCATION, VERTEX_SEARCH_ENGINE_ID and FIRESTORE_DATABASE_ID from vars of the same name."
  }

  assert {
    condition     = alltrue([for f in fileset("${path.module}/../../.github/workflows", "*.{yml,yaml}") : !strcontains(file("${path.module}/../../.github/workflows/${f}"), "GOOGLE_DRIVE_FOLDER_ID")])
    error_message = "GOOGLE_DRIVE_FOLDER_ID is retired; no workflow may mention it."
  }

  # Names the deploy computes, with NAME_SUFFIX empty for production and
  # -staging for staging (deploy_selects_the_stack_by_branch). Terraform's
  # names are checked against them in tests/onboardai.tftest.hcl (production)
  # and tests/staging.tftest.hcl (staging_deploy_names_match_terraform).
  assert {
    condition = (
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "--service-account=\"onboardai-$key-run$NAME_SUFFIX@$GCP_PROJECT_ID.iam.gserviceaccount.com\"") &&
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "name=\"onboardai-$1$NAME_SUFFIX\"") &&
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "--image=\"$REGISTRY/onboardai$NAME_SUFFIX/$key:$GITHUB_SHA\"") &&
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "docker push \"$REGISTRY/onboardai$NAME_SUFFIX/$SERVICE:$GITHUB_SHA\"")
    )
    error_message = "deploy.yml must deploy onboardai-<service>$NAME_SUFFIX as onboardai-<service>-run$NAME_SUFFIX from repository onboardai$NAME_SUFFIX, the names Terraform creates."
  }

  assert {
    condition     = !strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "allow-unauthenticated") && !strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "invoker-iam-check")
    error_message = "Public access is Terraform's (allUsers binding). The deployer cannot set IAM, so the workflow must not try."
  }
}

# Every repository variable a workflow reads has a gh command in the output, and
# every gh command sets a variable a workflow reads. The config job checks each
# one, and every value Terraform knows passes that check.
run "repository_variables_match_terraform" {
  command = apply

  assert {
    condition = toset(flatten([
      for f in fileset("${path.module}/../../.github/workflows", "*.{yml,yaml}") : [
        for m in regexall("vars\\.([A-Za-z0-9_]+)", file("${path.module}/../../.github/workflows/${f}")) : m[0]
      ]
      ])) == setunion(
      toset([for m in regexall("(?m)^gh variable set ([A-Z0-9_]+) ", output.github_variable_commands) : m[0]]),
      toset(["VOICE_PROVIDER", "GEMINI_TTS_MODEL", "GEMINI_TTS_LOCATION", "GEMINI_TTS_VOICE", "CHECKLIST_AGENT_ENABLED"])
    )
    error_message = "The vars.* the workflows read and the gh variable set commands in output github_variable_commands must be the same set, except the optional voice (#52) and CHECKLIST_AGENT_ENABLED (#51) variables, which have defaults in deploy.yml."
  }

  assert {
    condition = alltrue([
      for m in regexall("(?m)^gh variable set ([A-Z0-9_]+) ", output.github_variable_commands) :
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), format("          check %s \"$%s\" ", m[0], m[0]))
    ])
    error_message = "The config job of deploy.yml must check every repository variable."
  }

  assert {
    condition = alltrue([
      for m in regexall("(?m)^gh variable set ([A-Z0-9_]+) --repo [^ ]+ --body '([^']*)'$", output.github_variable_commands) :
      can(regex(regex(format("check %s \"\\$%s\" '([^']+)'", m[0], m[0]), file("${path.module}/../../.github/workflows/deploy.yml"))[0], m[1]))
      if contains(["GCP_PROJECT_ID", "GCP_REGION", "AI_MODE", "GEMINI_MODEL", "VERTEX_SEARCH_LOCATION", "VERTEX_SEARCH_ENGINE_ID", "FIRESTORE_DATABASE_ID"], m[0])
    ])
    error_message = "A value Terraform hands out would fail the config job's check in deploy.yml."
  }
}

run "wif_condition_matches_the_deploy_workflow" {
  command = plan

  assert {
    condition     = fileexists("${path.module}/../../.github/workflows/deploy.yml")
    error_message = "The WIF condition trusts .github/workflows/deploy.yml; it must exist."
  }

  # The conditions accept push and workflow_dispatch only; deploy.yml must be
  # triggered by exactly those, on main (production) and staging (staging).
  assert {
    condition     = can(regex("(?s)\non:\n  push:\n    branches: \\[main, staging\\]\n  workflow_dispatch:\n\n", file("${path.module}/../../.github/workflows/deploy.yml")))
    error_message = "deploy.yml must trigger on push to main or staging and workflow_dispatch only."
  }

  assert {
    condition     = alltrue([for f in fileset("${path.module}/../../.github/workflows", "*.{yml,yaml}") : !strcontains(file("${path.module}/../../.github/workflows/${f}"), "pull_request_target")])
    error_message = "pull_request_target must not be used."
  }
}

run "workflows_follow_public_repo_rules" {
  command = plan

  # Every remote action is pinned to a full commit SHA with a version comment.
  assert {
    condition = alltrue(flatten([
      for f in fileset("${path.module}/../../.github/workflows", "*.{yml,yaml}") : [
        for m in regexall("uses:\\s*(\\S+)([^\n]*)", file("${path.module}/../../.github/workflows/${f}")) :
        startswith(m[0], "./") || (can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$", m[0])) && can(regex("^ # v[0-9]+\\.[0-9]+\\.[0-9]+$", m[1])))
      ]
    ]))
    error_message = "Pin every action to a 40-character commit SHA followed by '# vX.Y.Z'."
  }

  # id-token: write only on the jobs that call Google Cloud: images, agent
  # (staging's intake agent, #30), checklist_agent (#51), deploy, and smoke for
  # one ID token (#57).
  assert {
    condition = (
      length(regexall("id-token: write", file("${path.module}/../../.github/workflows/deploy.yml"))) == 5 &&
      toset([for name, job in yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs : name if try(job.permissions["id-token"], "") == "write"]) == toset(["images", "agent", "checklist_agent", "deploy", "smoke"]) &&
      !strcontains(file("${path.module}/../../.github/workflows/ci.yml"), "id-token")
    )
    error_message = "id-token: write belongs to the images, agent, checklist_agent, deploy and smoke jobs of deploy.yml only."
  }

  # smoke's token is for one thing: the deployer's ID token for the api, only
  # when the run deployed the intake agent. No access token, no credentials
  # file, no gcloud, and nothing else in the job uses an action.
  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.permissions == { "id-token" = "write" } &&
      length([for st in yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps : st if can(st.uses)]) == 1 &&
      one([for st in yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps : st if can(st.uses)]).if == "needs.deploy.outputs.intake_agent == 'true'" &&
      startswith(one([for st in yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps : st.uses if can(st.uses)]), "google-github-actions/auth@") &&
      one([for st in yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps : st.with if can(st.uses)]) == {
        workload_identity_provider   = "$${{ needs.deploy.outputs.wif_provider }}"
        service_account              = "$${{ needs.deploy.outputs.deployer_sa }}"
        token_format                 = "id_token"
        id_token_audience            = "$${{ needs.deploy.outputs.api_url }}"
        id_token_include_email       = true
        create_credentials_file      = false
        export_environment_variables = false
      } &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.outputs.wif_provider == "$${{ vars.GCP_WIF_PROVIDER }}" &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.outputs.deployer_sa == "$${{ vars.GCP_DEPLOYER_SA }}"
    )
    error_message = "The smoke job's only action is google-github-actions/auth for an ID token (audience: the api URL) as the stack's deployer, when the intake agent was deployed, with no credentials file or exported variables."
  }

  assert {
    condition     = alltrue([for f in ["ci.yml", "deploy.yml"] : can(regex("(?m)^permissions:\n  contents: read$", file("${path.module}/../../.github/workflows/${f}")))])
    error_message = "Both workflows default to permissions: contents: read."
  }

  # Untrusted input never reaches a script: no run: block contains an
  # expression at all; values arrive through env.
  assert {
    condition = alltrue(flatten([
      for f in ["ci.yml", "deploy.yml"] : [
        for job in values(yamldecode(file("${path.module}/../../.github/workflows/${f}")).jobs) : [
          for step in try(job.steps, []) : !strcontains(try(step.run, ""), "$${{")
        ]
      ]
    ]))
    error_message = "run: scripts must not contain $${{ }} expressions; pass values through env."
  }

  # github.event.* appears only as an env value or in ci.yml's concurrency group.
  assert {
    condition = alltrue(flatten([
      for f in ["ci.yml", "deploy.yml"] : [
        for line in split("\n", file("${path.module}/../../.github/workflows/${f}")) :
        can(regex("^  group: ci-.*github\\.event\\.pull_request\\.number", line)) || can(regex("^\\s+[A-Z][A-Z0-9_]*: \\$\\{\\{ github\\.event\\.[a-z_.]+ \\}\\}$", line))
        if strcontains(line, "github.event.")
      ]
    ]))
    error_message = "Use github.event.* only as an env: value (or the PR number in ci.yml's concurrency group)."
  }

  # Every actions/checkout step sets persist-credentials: false (and there are some).
  assert {
    condition = length(flatten([
      for f in ["ci.yml", "deploy.yml"] : [
        for job in values(yamldecode(file("${path.module}/../../.github/workflows/${f}")).jobs) : [
          for step in try(job.steps, []) : step if startswith(try(step.uses, ""), "actions/checkout@")
        ]
      ]
      ])) > 0 && alltrue(flatten([
      for f in ["ci.yml", "deploy.yml"] : [
        for job in values(yamldecode(file("${path.module}/../../.github/workflows/${f}")).jobs) : [
          for step in try(job.steps, []) : try(step.with["persist-credentials"], null) == false
          if startswith(try(step.uses, ""), "actions/checkout@")
        ]
      ]
    ]))
    error_message = "Every checkout must set persist-credentials: false."
  }

  # The deploy can only run after CI passed on the same commit.
  assert {
    condition     = strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "uses: ./.github/workflows/ci.yml") && strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "needs: [ci, config]") && strcontains(file("${path.module}/../../.github/workflows/ci.yml"), "workflow_call:")
    error_message = "deploy.yml must call ci.yml and gate the image build on it."
  }

  # Images are built before the auth step writes credentials into the build context.
  assert {
    condition     = can(regex("(?s)name: Build image\n.*name: Authenticate to Google Cloud", file("${path.module}/../../.github/workflows/deploy.yml")))
    error_message = "Build images before google-github-actions/auth runs."
  }

  assert {
    condition     = alltrue([for f in ["ci.yml", "deploy.yml"] : !can(regex("gh pr merge|--auto|git push|auto-merge", file("${path.module}/../../.github/workflows/${f}")))])
    error_message = "Workflows must never merge, push or enable auto-merge."
  }
}

run "ci_skips_docker_builds_only_when_proven" {
  command = plan

  # deploy.yml always builds every image in CI.
  assert {
    condition     = yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.ci.with["run-all"] == true
    error_message = "deploy.yml must call ci.yml with run-all: true."
  }

  # (YAML 1.1 reads the key `on` as true.)
  assert {
    condition = (
      try(yamldecode(file("${path.module}/../../.github/workflows/ci.yml"))["on"], yamldecode(file("${path.module}/../../.github/workflows/ci.yml"))["true"]).workflow_call.inputs["run-all"].type == "boolean" &&
      try(yamldecode(file("${path.module}/../../.github/workflows/ci.yml"))["on"], yamldecode(file("${path.module}/../../.github/workflows/ci.yml"))["true"]).workflow_call.inputs["run-all"].default == false
    )
    error_message = "ci.yml needs a boolean workflow_call input run-all, default false."
  }

  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.changes.outputs.images == "$${{ steps.detect.outputs.images }}" &&
      one([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.changes.steps : s.env.RUN_ALL if try(s.id, "") == "detect"]) == "$${{ inputs.run-all }}"
    )
    error_message = "The changes job must publish images from step detect, which reads inputs.run-all."
  }

  # The list of image inputs: exactly these paths.
  assert {
    condition = toset([
      for p in split(" ", trimspace(replace(replace(regex("(?s)image_inputs=\\(\\s*(.*?)\\s*\\)", one([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.changes.steps : s.run if try(s.id, "") == "detect"]))[0], "/\\s+/", " "), "'", ""))) : p
    ]) == toset(["Dockerfile", ".dockerignore", "package.json", "package-lock.json", "index.html", "vite.config.*", "server", "src", "public", "scripts"])
    error_message = "image_inputs must be Dockerfile, .dockerignore, package.json, package-lock.json, index.html, vite.config.*, server, src, public, scripts."
  }

  # Fail safe: exactly one way to answer false, as the script's last line.
  assert {
    condition = (
      length(regexall("decide false", one([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.changes.steps : s.run if try(s.id, "") == "detect"]))) == 1 &&
      endswith(trimspace(one([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.changes.steps : s.run if try(s.id, "") == "detect"])), "decide false \"no image input changed in $range\"") &&
      strcontains(one([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.changes.steps : s.run if try(s.id, "") == "detect"]), "0000000000000000000000000000000000000000")
    )
    error_message = "Detection must answer true on every path except the final proven no-change case (including a zero before SHA)."
  }

  # The three checks keep their names: the matrix job always runs and its steps decide.
  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.docker.name == "Docker build ($${{ matrix.service }})" &&
      yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.docker.strategy.matrix.service == ["web", "api", "tts"] &&
      yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.docker.needs == "changes" &&
      try(yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.docker.if, "$${{ !cancelled() }}") == "$${{ !cancelled() }}"
    )
    error_message = "Keep 'Docker build (web|api|tts)': gate the build at step level, never with a job-level if that can skip the matrix."
  }

  assert {
    condition = alltrue([
      for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.docker.steps :
      try(s.if, "") == "needs.changes.outputs.images != 'false'"
      if strcontains(try(s.run, ""), "docker build") || startswith(try(s.uses, ""), "actions/checkout@")
      ]) && length([
      for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.docker.steps : s
      if strcontains(try(s.run, ""), "docker build") && try(s.if, "") == "needs.changes.outputs.images != 'false'"
    ]) == 1
    error_message = "The checkout and docker build steps must run unless changes.outputs.images is 'false'."
  }

  assert {
    condition = length([
      for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.docker.steps : s
      if try(s.if, "") == "needs.changes.outputs.images == 'false'" && strcontains(try(s.run, ""), "::notice")
    ]) == 1
    error_message = "One step must print a ::notice when the build is skipped."
  }

  # Verify is unconditional.
  assert {
    condition     = try(yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.verify.if, null) == null && try(yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.verify.needs, null) == null && alltrue([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.verify.steps : try(s.if, null) == null])
    error_message = "The verify job (format check, tests, build, secret scan) must always run."
  }
}

# ---------------------------------------------------------------------------
# One workflow, two stacks (issue #20)
# ---------------------------------------------------------------------------

# main deploys production, staging deploys staging, nothing else deploys. Every
# job that reads vars.* names the GitHub environment of its stack, so staging
# reads its environment variables and production its repository variables.
run "deploy_selects_the_stack_by_branch" {
  command = plan

  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.ci.if == "github.ref == 'refs/heads/main' || github.ref == 'refs/heads/staging'" &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.config.if == "github.ref == 'refs/heads/main' || github.ref == 'refs/heads/staging'"
    )
    error_message = "ci and config must run for refs/heads/main and refs/heads/staging only (the refs the two WIF providers trust)."
  }

  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).env.DEPLOY_ENV == "$${{ github.ref == 'refs/heads/staging' && 'staging' || 'production' }}" &&
      alltrue([for j in ["config", "images", "agent", "deploy"] : yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs[j].environment == "$${{ github.ref == 'refs/heads/staging' && 'staging' || 'production' }}"])
    )
    error_message = "DEPLOY_ENV and the environment of config, images, agent and deploy must all map refs/heads/staging to staging and anything else (main) to production."
  }

  # vars.* in a job without an environment would read production's repository
  # variables during a staging deploy.
  assert {
    condition = alltrue([
      for name, job in yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs :
      try(job.environment, null) == "$${{ github.ref == 'refs/heads/staging' && 'staging' || 'production' }}"
      if strcontains(jsonencode(job), "vars.")
    ]) && !strcontains(jsonencode(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).env), "vars.")
    error_message = "Every job that reads vars.* must name the stack's environment, and the workflow-level env must not read vars.* at all."
  }

  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).concurrency.group == "deploy-$${{ github.ref == 'refs/heads/main' && 'production' || github.ref == 'refs/heads/staging' && 'staging' || format('none-{0}', github.run_id) }}" &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).concurrency["cancel-in-progress"] == false
    )
    error_message = "One deploy per environment: group deploy-production for main (unchanged), deploy-staging for staging, a group of its own for any other ref; never cancelled."
  }

  # (YAML 1.1 reads the key `on` as true.)
  assert {
    condition = (
      try(yamldecode(file("${path.module}/../../.github/workflows/ci.yml"))["on"], yamldecode(file("${path.module}/../../.github/workflows/ci.yml"))["true"]).pull_request.branches == ["main", "staging"] &&
      try(yamldecode(file("${path.module}/../../.github/workflows/ci.yml"))["on"], yamldecode(file("${path.module}/../../.github/workflows/ci.yml"))["true"]).push.branches == ["main", "staging"]
    )
    error_message = "ci.yml must run on pull requests into, and pushes to, main and staging."
  }

  # A staging run must never deploy with production's values, nor the other way round.
  assert {
    condition = (
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "          check GCP_DEPLOYER_SA \"$GCP_DEPLOYER_SA\" \"^onboardai-deployer$${NAME_SUFFIX}@$${GCP_PROJECT_ID}\\.iam\\.gserviceaccount\\.com$\"\n") &&
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "          for name in GCP_WIF_PROVIDER VERTEX_SEARCH_ENGINE_ID FIRESTORE_DATABASE_ID; do\n") &&
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "if [[ -n \"$NAME_SUFFIX\" && \"$value\" != *\"$NAME_SUFFIX\" ]] || [[ -z \"$NAME_SUFFIX\" && \"$value\" == *-staging ]]; then")
    )
    error_message = "The config job must check that the deployer, WIF provider, engine and database belong to the stack being deployed."
  }

  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.env.GCP_PROJECT_ID == "$${{ needs.deploy.outputs.project_id }}" &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.env.GCP_REGION == "$${{ needs.deploy.outputs.region }}" &&
      length(regexall("update-traffic onboardai-\\$\\{pair%%=\\*\\}\\$NAME_SUFFIX ", file("${path.module}/../../.github/workflows/deploy.yml"))) == 2
    )
    error_message = "Rollback commands must name the deployed stack's services, project and region."
  }
}

run "staging_deploy_flags_match_terraform" {
  command = plan

  variables {
    environment = "staging"
  }

  assert {
    condition = alltrue([
      for key, flags in output.cloud_run_deploy_flags :
      strcontains(file("${path.module}/../../.github/workflows/deploy.yml"), "      ${upper(key)}_RUN_FLAGS: ${flags}\n")
    ])
    error_message = "Staging's flags differ from deploy.yml's *_RUN_FLAGS, which serve both stacks."
  }
}

run "production_values_pass_the_production_checks" {
  command = apply

  assert {
    condition = alltrue([
      for m in regexall("(?m)^gh variable set ([A-Z0-9_]+) --repo [^ ]+ --body '([^']*)'$", output.github_variable_commands) :
      !endswith(m[1], "-staging") if contains(["GCP_WIF_PROVIDER", "VERTEX_SEARCH_ENGINE_ID", "FIRESTORE_DATABASE_ID"], m[0])
    ]) && google_service_account.deployer.account_id == "onboardai-deployer"
    error_message = "Production's provider, engine and database must not look like staging's, or the config job would refuse the production deploy."
  }
}

# ---------------------------------------------------------------------------
# Database migrations in every deploy (#45); the intake agent on staging only
# (#30)
# ---------------------------------------------------------------------------

# Every deploy, production and staging, migrates before it deploys anything.
# The intake agent deploys only on staging and only when the commit has its
# deploy command; otherwise the api deploys without it. tests/accounts.tftest.hcl
# and tests/accounts_production.tftest.hcl check that the names these steps use
# are the ones Terraform creates.
run "migrations_run_everywhere_and_the_agent_only_on_staging" {
  command = plan

  # The agent job: after every image is pushed; checks out, then decides. Each
  # later step runs only when it decided to deploy, and the job outputs that
  # decision and the engine name.
  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.needs == "images" &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.outputs == {
        deployed = "$${{ steps.decide.outputs.deploy }}"
        engine   = "$${{ steps.agent.outputs.engine }}"
      } &&
      length(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps) == 8 &&
      startswith(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[0].uses, "actions/checkout@") &&
      try(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[0].if, null) == null &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[1].id == "decide" &&
      try(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[1].if, null) == null &&
      alltrue([for s in slice(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps, 2, 8) : try(s.if, "") == "steps.decide.outputs.deploy == 'true'"])
    )
    error_message = "The agent job runs after images, checks out and decides (step decide) unconditionally, gates every later step on steps.decide.outputs.deploy == 'true', and outputs deployed and engine."
  }

  # The decision: never off staging, and on staging only when package.json
  # has the intake-agent:deploy script; each skip prints a notice.
  assert {
    condition = (
      can(regex("(?s)^set -euo pipefail\\nif \\[\\[ \"\\$GITHUB_REF\" != refs/heads/staging \\]\\]; then\\n  echo \"::notice [^\\n]+\\n  deploy=false\\nelif \\[\\[ -z \"\\$\\(jq -r '\\.scripts\\[\"intake-agent:deploy\"\\] // \"\" \\| strings' package\\.json\\)\" \\]\\]; then\\n  echo \"::notice [^\\n]+\\n  deploy=false\\nelse\\n  deploy=true\\nfi\\necho \"deploy=\\$deploy\" >> \"\\$GITHUB_OUTPUT\"\\n$", yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[1].run)) &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[1]["working-directory"] == "repo"
    )
    error_message = "The agent deploys only on refs/heads/staging and only when package.json has an intake-agent:deploy script; otherwise deploy=false with a ::notice."
  }

  # The deploy job waits for the agent and takes its result, then migrates
  # before it deploys anything, in every stack.
  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.needs == ["images", "agent", "checklist_agent"] &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.env.INTAKE_AGENT_DEPLOYED == "$${{ needs.agent.outputs.deployed }}" &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.env.INTAKE_AGENT_ENGINE == "$${{ needs.agent.outputs.engine }}" &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.outputs.intake_agent == "$${{ steps.deploy.outputs.intake_agent }}" &&
      [for s in yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps : s.name] == ["Authenticate to Google Cloud", "Set up gcloud", "Record the revisions serving now (rollback targets)", "Migrate the databases", "Update the document reconciliation job", "Deploy", "Print rollback commands"] &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].id == "migrate" &&
      try(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].if, null) == null &&
      try(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[4].if, null) == null &&
      try(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[5].if, null) == null &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[6].env.MIGRATE_OUTCOME == "$${{ steps.migrate.outcome }}"
    )
    error_message = "deploy needs [images, agent, checklist_agent], takes the agent job's deployed and engine, and runs 'Migrate the databases' (id migrate) in every stack, with no condition, then 'Update the document reconciliation job', right before the Deploy step."
  }

  # The deploy job outlasts two full migration attempts (timeout x
  # (max_retries + 1)) plus 15 minutes for the job start, the log read and the
  # three service deploys.
  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy["timeout-minutes"] * 60 >= tonumber(trimsuffix(google_cloud_run_v2_job.db_migrate[0].template[0].template[0].timeout, "s")) * (google_cloud_run_v2_job.db_migrate[0].template[0].template[0].max_retries + 1) + 15 * 60
    )
    error_message = "The deploy job's timeout-minutes must cover the migration job's timeout x (max_retries + 1) plus 15 minutes for the rest of the job."
  }

  # The migration: this commit's api image, executed with --wait; a failure
  # stops the step (and with it the deploy) after printing the lines.
  assert {
    condition = (
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].run, "gcloud run jobs update \"$job\" --project=\"$GCP_PROJECT_ID\" --region=\"$GCP_REGION\" --image=\"$REGISTRY/onboardai$NAME_SUFFIX/api:$GITHUB_SHA\" --quiet\n") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].run, "execution=$(gcloud run jobs execute \"$job\" --project=\"$GCP_PROJECT_ID\" --region=\"$GCP_REGION\" --wait --quiet --format='value(metadata.name)' 2> \"$progress\") || status=$?\n") &&
      can(regex("(?s)printf '%s\\\\n' \"\\$\\{lines:-[^\\n]*\\n.*\\nif \\(\\(status != 0\\)\\); then\\n  echo \"::error::[^\\n]*\"\\n  exit 1\\nfi\\nif \\[\\[ \"\\$complete\" == false \\]\\]; then\\n  echo \"::warning::[^\\n]*\"\\nfi\\n$", yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].run))
    )
    error_message = "The migration step updates the job to this commit's api image, executes it with --wait, prints its lines, then fails with ::error:: if the execution failed (an incomplete log only warns)."
  }

  # #54: the step reads the job before it updates it, and a job it cannot read
  # (not applied yet, or no access) stops the step with an error that names
  # the missing apply and gcloud's own first error line, before anything runs.
  assert {
    condition = (
      [for m in regexall("gcloud run jobs (describe|update|execute) ", yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].run) : m[0]] == ["describe", "update", "execute"] &&
      can(regex("^set -euo pipefail\\njob=\"onboardai-db-migrate\\$NAME_SUFFIX\"\\nview=\"onboardai-db-migrate\\$NAME_SUFFIX\"\\nif ! gcloud run jobs describe \"\\$job\" --project=\"\\$GCP_PROJECT_ID\" --region=\"\\$GCP_REGION\" [^\\n]*> /dev/null 2> \"\\$RUNNER_TEMP/migrate-describe\\.log\"; then\\n  echo \"::error::Cannot read the migration job \\$job\\. Apply terraform/onboardai \\(\\$DEPLOY_ENV\\) first; it creates the job and the deployer's access to it\\. Nothing was deployed\\.\"\\n  echo \"gcloud: \\$\\(grep -m 1 '\\^ERROR' \"\\$RUNNER_TEMP/migrate-describe\\.log\" \\|\\| head -n 1 \"\\$RUNNER_TEMP/migrate-describe\\.log\"\\)\"\\n  exit 1\\nfi\\ngcloud run jobs update \"\\$job\" ", yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].run))
    )
    error_message = "Before gcloud run jobs update, the migration step must run gcloud run jobs describe on the job and, if that fails, print the ::error:: naming the missing terraform/onboardai apply and gcloud's first error line, then exit 1."
  }

  # The log: this execution only, through the stack's log view, retried a
  # bounded number of times, and only the runner's lines are printed.
  assert {
    condition = (
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].run, "filter=\"labels.\\\"run.googleapis.com/execution_name\\\"=\\\"$execution\\\" AND timestamp>=\\\"$since\\\"\"\n") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].run, "gcloud logging read \"$filter\" --project=\"$GCP_PROJECT_ID\" --bucket=_Default --location=global --view=\"$view\" ") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].run, "select(test(\"^(\\\\[sql\\\\] |\\\\[firestore\\\\] |Migrations finished|Migration stopped)\"))") &&
      length(regexall("textPayload", yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].run)) == 2 &&
      !can(regex("(echo|printf|cat)[^\\n]*\\$\\{?entries", yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].run)) &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].run, "for attempt in 1 2 3 4 5 6 7 8; do\n") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[3].run, "if ((attempt < 8)); then sleep 5; fi\n")
    )
    error_message = "The migration step reads only its own execution through the log view, retries at most 8 times 5 s apart, and prints only lines starting with [sql], [firestore], Migrations finished or Migration stopped."
  }

  # The smoke test checks accounts in every stack, and the agent's checks only
  # when this run deployed the agent. POST /mcp carries the deployer's ID token
  # (#57) and must get the api's own 401, not Cloud Run's.
  assert {
    condition = (
      [for st in yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps : st.name] == ["Check the deployed services", "Get an ID token for the api", "Check employee accounts and form import", "Print rollback commands"] &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.env.INTAKE_AGENT == "$${{ needs.deploy.outputs.intake_agent }}" &&
      try(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[0].if, null) == null &&
      try(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[2].if, null) == null &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[2].env.API_ID_TOKEN == "$${{ steps.api-token.outputs.id_token }}" &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[1].id == "api-token" &&
      can(regex("(?s)if jq -e '\\.accounts == true' > /dev/null <<< \"\\$config\"; then\\n.*\\nif \\[\\[ \"\\$INTAKE_AGENT\" != true \\]\\]; then\\n[^\\n]*\\n  exit \"\\$failed\"\\nfi\\n.*'\\.employeeImport == true'.*-H @- --data '\\{\\}' \"\\$API_URL/mcp\" <<< \"X-Serverless-Authorization: Bearer \\$API_ID_TOKEN\".*if \\[\\[ \"\\$code\" == 401 \\]\\] && jq -e '\\.jsonrpc == \"2\\.0\" and \\.error\\.code == -32001'", yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[2].run)) &&
      !strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[2].run, "Authorization: Bearer $API_ID_TOKEN\" -")
    )
    error_message = "The smoke test requires accounts: true in every stack; employeeImport: true and the api's own 401 for POST /mcp with the deployer's ID token (X-Serverless-Authorization, on stdin) only when the run deployed the intake agent."
  }

  # #57: the api and tts may be private, so every api check goes through web
  # (no GCP credentials needed, and it passes before and after the IAM apply),
  # the signed-out voice call proves web -> api (the api's own 401), and GET /api/health/tts proves web -> api -> tts with both ID tokens (#67). The api and tts
  # URLs are only reported, never failed.
  assert {
    condition = (
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[0].run, "probe \"web GET /api/health (proxied to api)\" \"$WEB_URL/api/health\" ") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[0].run, "probe \"web GET /web-health\" \"$WEB_URL/web-health\" ") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[0].run, "probe_json \"web POST /api/voice signed out (api's own 401)\" \"$WEB_URL/api/voice\" 6 '5[0-9][0-9]|000' 401 '.code == \"AUTH_REQUIRED\"' -X POST ") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[0].run, "probe_json \"web GET /api/health/tts (api -> tts)\" \"$WEB_URL/api/health/tts\" 6 '5[0-9][0-9]|000' 200 '.ok == true and .tts == \"ok\"' ") &&
      !strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[0].run, "audio/wav") &&
      !strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[0].run, "PROBE_TYPE") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[2].run, "config=$(curl -sS --fail --max-time 30 \"$WEB_URL/api/config\")") &&
      [for m in regexall("\\$(API_URL|TTS_URL)/[^\" ]*", join("\n", [for st in yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps : try(st.run, "")])) : m[0]] == ["API_URL", "TTS_URL", "API_URL"] &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[0].run, "reach \"onboardai-api$NAME_SUFFIX\" \"$API_URL/api/health\"\nreach \"onboardai-tts$NAME_SUFFIX\" \"$TTS_URL/health\"\n") &&
      !can(regex("(?s)reach\\(\\) \\{\\n(?:[^}]|\\}[^\\n])*(failed|exit|return 1)", yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[0].run))
    )
    error_message = "The smoke test must check /web-health, /api/health, POST /api/voice signed out (the api's own 401 AUTH_REQUIRED), GET /api/health/tts (tts == ok) and /api/config through web, call the api URL directly only for POST /mcp, and only report (never fail on) the api's and tts's own URLs."
  }

  # The voice check sends a valid voice request (server/voice-request.mjs: text
  # of at most 700 characters, rate one of 0.85, 0.95, 1, 1.05), kept tiny.
  assert {
    condition = (
      length(jsondecode(regex("/api/voice\" [^\\n]*--data '([^']+)'", yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[0].run)[0]).text) <= 20 &&
      length(trimspace(jsondecode(regex("/api/voice\" [^\\n]*--data '([^']+)'", yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[0].run)[0]).text)) > 0 &&
      contains([0.85, 0.95, 1, 1.05], jsondecode(regex("/api/voice\" [^\\n]*--data '([^']+)'", yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.smoke.steps[0].run)[0]).rate)
    )
    error_message = "POST /api/voice must send {\"text\": <1 to 20 characters>, \"rate\": 0.85|0.95|1|1.05}."
  }

  # The agent's toolchain never handles credentials: dependencies install
  # without install scripts before the auth step, and the repository is checked
  # out below the workspace root the auth step writes its credentials file to.
  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[0].with.path == "repo" &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[4].run == "npm ci --omit=dev --ignore-scripts" &&
      startswith(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[5].uses, "google-github-actions/auth@") &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[3].with["enable-cache"] == false &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[7].id == "agent" &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[7]["working-directory"] == "repo"
    )
    error_message = "The agent job checks out into repo/, installs with --ignore-scripts before authenticating, runs uv without a cache, and deploys from repo/."
  }

  # The deploy command gets the secret's ID, never its value, and its last
  # stdout line must be a reasoning engine in INTAKE_AGENT_LOCATION.
  assert {
    condition = (
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[7].run, "--mcp-token-secret \"onboardai-intake-mcp-token$NAME_SUFFIX\"") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[7].run, "--mcp-url \"$api_url/mcp\"") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[7].run, "engine=$(tail -n 1 \"$log\")") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.agent.steps[7].run, "/reasoningEngines/[0-9]+$ ]]; then") &&
      !can(regex("(?i)secrets versions access|INTAKE_MCP_TOKEN=[^o]|DATABASE_URL=[^o]", file("${path.module}/../../.github/workflows/deploy.yml")))
    )
    error_message = "The agent deploy passes the token's secret ID only, and the workflow never reads a secret value."
  }
}

# CI proves that every migration file is detected and applies cleanly, twice,
# to fresh databases, with the targets the migration job uses.
run "ci_applies_migrations_to_throwaway_databases" {
  command = apply

  assert {
    condition     = length([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.verify.steps : s if try(s.run, "") == "npm run db:migrations:check"]) == 1
    error_message = "Verify must run npm run db:migrations:check (misnamed or duplicate-numbered migration files fail CI)."
  }

  # Unconditional, so it also gates every deploy (deploy.yml calls ci.yml).
  assert {
    condition = (
      try(yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.if, null) == null &&
      try(yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.needs, null) == null &&
      can(regex("^postgres:17\\.[0-9]+-alpine@sha256:[0-9a-f]{64}$", yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.services.postgres.image)) &&
      can(regex("^gcr\\.io/google\\.com/cloudsdktool/google-cloud-cli:[0-9.]+-emulators@sha256:[0-9a-f]{64}$", yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.env.FIRESTORE_EMULATOR_IMAGE)) &&
      can(regex("^postgresql://onboardai:[A-Za-z0-9_]+@127\\.0\\.0\\.1:5432/onboardai$", yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.env.DATABASE_URL)) &&
      yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.env.FIRESTORE_EMULATOR_HOST == "127.0.0.1:8681" &&
      yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.env.MIGRATION_TARGETS == one([for e in google_cloud_run_v2_job.db_migrate[0].template[0].template[0].containers[0].env : e.value if e.name == "MIGRATION_TARGETS"])
    )
    error_message = "The migrations job always runs, against PostgreSQL 17 and gcloud's Firestore emulator (both pinned by digest), with the migration job's MIGRATION_TARGETS."
  }

  # Run 1 applies every listed file; run 2 applies none; neither leaks the
  # URL or the password.
  assert {
    condition = (
      strcontains(one([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.steps : s.run if try(s.name, "") == "Apply the migrations twice"]), "summary=$(npm run --silent db:migrations:check | tail -n 1)\n") &&
      strcontains(one([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.steps : s.run if try(s.name, "") == "Apply the migrations twice"]), "\nmigrate first\n") &&
      strcontains(one([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.steps : s.run if try(s.name, "") == "Apply the migrations twice"]), "\"Migrations finished: sql $sql applied, 0 already applied; firestore $firestore applied, 0 already applied.\"\n") &&
      strcontains(one([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.steps : s.run if try(s.name, "") == "Apply the migrations twice"]), "\nmigrate second\n") &&
      strcontains(one([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.steps : s.run if try(s.name, "") == "Apply the migrations twice"]), "\"Migrations finished: sql 0 applied, $sql already applied; firestore 0 applied, $firestore already applied.\"\n") &&
      strcontains(one([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.steps : s.run if try(s.name, "") == "Apply the migrations twice"]), "check second \"Applied lines\" \"$(count '^\\[(sql|firestore)\\] Applied: ' \"$out\")\" 0\n") &&
      strcontains(one([for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.steps : s.run if try(s.name, "") == "Apply the migrations twice"]), "grep -qiE 'postgres(ql)?://|${regex("^postgresql://onboardai:([A-Za-z0-9_]+)@", yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.migrations.env.DATABASE_URL)[0]}' \"$out\" \"$err\"")
    )
    error_message = "The migrations job must apply every file the check lists on the first run, none on the second, and fail if either run prints the database URL or its password."
  }

  assert {
    condition = length([
      for s in yamldecode(file("${path.module}/../../.github/workflows/ci.yml")).jobs.docker.steps : s
      if try(s.if, "") == "needs.changes.outputs.images != 'false' && matrix.service == 'api'" && try(s.run, "") == "docker run --rm --platform linux/amd64 onboardai-api:ci npm run --silent db:migrations:check"
    ]) == 1
    error_message = "The api Docker check must run npm run db:migrations:check inside the built api image (the migration job's image)."
  }
}

# #79: the deploy points the document reconciliation job at the api image it
# deploys, never executes it, and skips with a notice while Terraform has not
# created the job. The api labels its sync log lines with the stack.
run "deploy_updates_the_reconcile_job_to_the_api_image" {
  command = plan

  # Same image tag as the api service and the migration job; names are the
  # job's name in Terraform (tests/docs_reconcile.tftest.hcl) with NAME_SUFFIX.
  assert {
    condition = (
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[4].name == "Update the document reconciliation job" &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[4].run, "job=\"onboardai-docs-reconcile$NAME_SUFFIX\"\n") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[4].run, "gcloud run jobs update \"$job\" --project=\"$GCP_PROJECT_ID\" --region=\"$GCP_REGION\" --image=\"$REGISTRY/onboardai$NAME_SUFFIX/api:$GITHUB_SHA\" --quiet") &&
      local.docs_reconcile_job_name == "onboardai-docs-reconcile"
    )
    error_message = "The deploy must run gcloud run jobs update on onboardai-docs-reconcile$NAME_SUFFIX with --image $REGISTRY/onboardai$NAME_SUFFIX/api:$GITHUB_SHA, the tag the api service gets."
  }

  # Never executes the job, and never creates or deletes it.
  assert {
    condition = (
      !can(regex("gcloud run jobs (execute|create|delete|replace)[^\\n]*reconcile", file("${path.module}/../../.github/workflows/deploy.yml"))) &&
      length(regexall("gcloud run jobs execute", file("${path.module}/../../.github/workflows/deploy.yml"))) == 1 &&
      !strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[4].run, "jobs execute")
    )
    error_message = "The deploy never executes, creates or deletes the reconcile job: the only gcloud run jobs execute is the migration's, and the scheduler starts the reconcile job."
  }

  # A missing job skips with a notice and does not fail the deploy.
  assert {
    condition = (
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[4].run, "gcloud run jobs describe \"$job\"") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[4].run, "could not be found|not found|may not exist|run\\.jobs\\.get") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[4].run, "::notice title=Reconcile job skipped::") &&
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[4].run, "::warning title=Reconcile job not updated::") &&
      !strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[4].run, "::error")
    )
    error_message = "A reconcile job that is missing (not applied yet) skips with a ::notice; any other error is a ::warning; neither fails the deploy."
  }

  # The api names its stack in its sync log lines (C-ENV): staging or production.
  assert {
    condition = (
      strcontains(yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).jobs.deploy.steps[5].run, "api_env+=\",ONBOARDAI_ENVIRONMENT=$DEPLOY_ENV\"\n") &&
      yamldecode(file("${path.module}/../../.github/workflows/deploy.yml")).env.DEPLOY_ENV == "$${{ github.ref == 'refs/heads/staging' && 'staging' || 'production' }}"
    )
    error_message = "The api env must carry ONBOARDAI_ENVIRONMENT=$DEPLOY_ENV (staging or production)."
  }
}
