//! Jev, a decision model, behind whichever gateway the person has a key for.
//!
//! Jev writes no text. You send it one block of state and a set of typed
//! questions, and it answers every one of them in the same call, each with a
//! probability. That is the whole model. It is about a tenth of a second and a
//! hundredth of a cent per call, which is what makes it usable in places a
//! chat model is far too slow and too expensive to sit: on every command an
//! agent wants to run, on every turn of a worker's output.
//!
//! Two gateways serve it, and they disagree about the details. OpenRouter
//! calls a yes/no question a `noul` and names the model `typesafe/jev-1.13`.
//! Vercel calls the same question a `boolean`, puts the model in a header, and
//! names it `typesafe-ai/jev`. [`Jev`] is the one place that knows any of
//! that. Everything above it writes one kind of question and reads one kind of
//! answer.
//!
//! It lives in Rust rather than in the window for two reasons. The key never
//! reaches the web view, and the worker binary is a separate process that
//! needs the same client for the approval gate.
//!
//! Everything here is optional. With no key, [`Jev::available`] is `None` and
//! every caller does exactly what it did before the beta existed.

use std::collections::HashMap;
use std::time::Duration;

use crate::harness_settings::HarnessSettings;

/// Jev answers in about 100ms. Anything past this is a network fault, and the
/// caller has a person or a plain default waiting behind it.
const TIMEOUT: Duration = Duration::from_secs(10);

/// How the worker process is told which gateway to use and with what key.
/// The window reads them from settings; the worker is a separate program.
pub const PROVIDER_VAR: &str = "BERDLOOP_DECISIONS_PROVIDER";
pub const KEY_VAR: &str = "BERDLOOP_DECISIONS_KEY";

/// A gateway that serves Jev.
///
/// Adding a third one means adding a variant and answering the four questions
/// below. Nothing outside this file changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    OpenRouter,
    VercelGateway,
}

impl Provider {
    pub fn id(self) -> &'static str {
        match self {
            Provider::OpenRouter => "openrouter",
            Provider::VercelGateway => "vercel",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "openrouter" => Some(Provider::OpenRouter),
            "vercel" => Some(Provider::VercelGateway),
            _ => None,
        }
    }

    /// What a person sees in the settings.
    pub fn label(self) -> &'static str {
        match self {
            Provider::OpenRouter => "OpenRouter",
            Provider::VercelGateway => "Vercel AI Gateway",
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Provider::OpenRouter => "https://openrouter.ai/api/alpha/decisions",
            Provider::VercelGateway => "https://ai-gateway.vercel.sh/v1/evaluation-model",
        }
    }

    fn model(self) -> &'static str {
        match self {
            Provider::OpenRouter => "typesafe/jev-1.13",
            Provider::VercelGateway => "typesafe-ai/jev",
        }
    }

    /// What this gateway calls a yes/no question.
    ///
    /// The same question type, two names. Callers write `boolean`, because it
    /// is the word that explains itself.
    fn boolean_type(self) -> &'static str {
        match self {
            Provider::OpenRouter => "noul",
            Provider::VercelGateway => "boolean",
        }
    }
}

/// One answer, flattened to what a decision actually needs.
///
/// Jev returns a full probability distribution. Callers here want the pick and
/// one number saying how sure it is, so the distribution is folded into
/// `confidence` when the gateway does not name one itself.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    /// The chosen option, the score, or "true"/"false" for a yes/no question.
    pub value: String,
    /// 0 to 1. For a yes/no question this is how sure it is of that answer.
    pub confidence: f64,
}

pub type Answers = HashMap<String, Answer>;

/// Rewrite the question set into the words one gateway understands.
fn questions_for(provider: Provider, questions: &serde_json::Value) -> serde_json::Value {
    let Some(map) = questions.as_object() else {
        return questions.clone();
    };
    let boolean = provider.boolean_type();
    let rewritten = map
        .iter()
        .map(|(id, question)| {
            let mut question = question.clone();
            if let Some(fields) = question.as_object_mut() {
                if fields.get("type").and_then(|t| t.as_str()) == Some("boolean") {
                    fields.insert("type".into(), boolean.into());
                }
            }
            (id.clone(), question)
        })
        .collect();
    serde_json::Value::Object(rewritten)
}

/// The largest probability in a distribution, whatever shape it came in.
fn peak(value: &serde_json::Value) -> Option<f64> {
    value
        .get("probabilities")?
        .as_object()?
        .values()
        .filter_map(serde_json::Value::as_f64)
        .fold(None, |best: Option<f64>, p| {
            Some(best.map_or(p, |b| b.max(p)))
        })
}

/// Read one answer, in either gateway's shape.
fn answer_of(value: &serde_json::Value) -> Option<Answer> {
    // A yes/no answer is a bare probability, and is its own confidence.
    // OpenRouter calls the field `noul`; Vercel calls it `probability`.
    let yes_no = value
        .get("noul")
        .or_else(|| value.get("probability"))
        .and_then(serde_json::Value::as_f64);
    if let Some(probability) = yes_no {
        let yes = probability >= 0.5;
        return Some(Answer {
            value: if yes { "true" } else { "false" }.to_string(),
            confidence: if yes { probability } else { 1.0 - probability },
        });
    }
    let picked = value
        .get("choice")
        .or_else(|| value.get("score"))
        .map(|v| match v.as_str() {
            Some(text) => text.to_string(),
            None => v.to_string(),
        })?;
    let confidence = value
        .get("confidence")
        .and_then(serde_json::Value::as_f64)
        // No confidence field, which is every Vercel answer: the peak of the
        // distribution means the same thing in the same direction.
        .or_else(|| peak(value))
        .unwrap_or(0.0);
    Some(Answer {
        value: picked,
        confidence,
    })
}

/// Pull every answer out of a response body. Both gateways key them by ID.
pub fn answers_of(body: &serde_json::Value) -> Answers {
    body.get("answers")
        .and_then(serde_json::Value::as_object)
        .map(|answers| {
            answers
                .iter()
                .filter_map(|(id, value)| Some((id.clone(), answer_of(value)?)))
                .collect()
        })
        .unwrap_or_default()
}

/// A decision model and the gateway it is reached through.
///
/// Build one with [`Jev::available`] and the rest of the app never asks which
/// gateway answered.
pub struct Jev {
    provider: Provider,
    key: String,
}

impl Jev {
    /// The client for these settings, or `None` when the beta is off.
    ///
    /// When both keys are set, OpenRouter answers. That order is stated in the
    /// settings screen, so nobody has to guess which key is paying.
    pub fn available(settings: &HarnessSettings) -> Option<Self> {
        if !settings.beta {
            return None;
        }
        [
            (Provider::OpenRouter, &settings.openrouter_key),
            (Provider::VercelGateway, &settings.vercel_key),
        ]
        .into_iter()
        .find(|(_, key)| !key.trim().is_empty())
        .map(|(provider, key)| Self {
            provider,
            key: key.trim().to_string(),
        })
    }

    /// The client a worker process was launched with, if any.
    pub fn from_env() -> Option<Self> {
        let key = std::env::var(KEY_VAR).unwrap_or_default();
        let provider = Provider::from_id(&std::env::var(PROVIDER_VAR).unwrap_or_default())?;
        (!key.trim().is_empty()).then(|| Self {
            provider,
            key: key.trim().to_string(),
        })
    }

    pub fn provider(&self) -> Provider {
        self.provider
    }

    /// The key, for handing to a worker process. It goes nowhere else.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Ask one set of questions about one state. Blocks until it answers.
    ///
    /// Deliberately blocking. Every caller either has a person waiting on the
    /// other side of it or runs on a background thread already.
    pub fn decide(&self, state: &str, questions: &serde_json::Value) -> Result<Answers, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .map_err(|_| "Could not start the request.".to_string())?;
        let questions = questions_for(self.provider, questions);
        let request = client
            .post(self.provider.endpoint())
            .header("Authorization", format!("Bearer {}", self.key));
        // The two gateways disagree about where the model name goes.
        let request = match self.provider {
            Provider::OpenRouter => {
                request
                    .header("X-Title", "Berdloop")
                    .json(&serde_json::json!({
                        "model": self.provider.model(),
                        "state": state,
                        "questions": questions,
                    }))
            }
            Provider::VercelGateway => request
                .header("ai-evaluation-model-specification-version", "4")
                .header("ai-model-id", self.provider.model())
                .json(&serde_json::json!({ "state": state, "questions": questions })),
        };
        let response = request
            .send()
            .map_err(|_| format!("Could not reach {}.", self.provider.label()))?;
        if !response.status().is_success() {
            return Err(format!(
                "{} refused the request: {}",
                self.provider.label(),
                response.status()
            ));
        }
        let body: serde_json::Value = response
            .json()
            .map_err(|_| format!("{} returned something unreadable.", self.provider.label()))?;
        Ok(answers_of(&body))
    }

    /// Screen one command before a person is woken up.
    ///
    /// Everything that is not a confident read-only goes to a person: a
    /// network fault, an answer that did not parse, a command on the list
    /// below, or any doubt at all.
    pub fn screen_command(&self, tool: &str, command: &str) -> Screen {
        let lowered = command.to_lowercase();
        if NEVER_AUTOMATIC.iter().any(|bad| lowered.contains(bad)) {
            return Screen::AskPerson;
        }
        let questions = serde_json::json!({
            "effect": {
                "type": "choice",
                "instructions": "What does running this command do to the machine and the repository?",
                "criteria": {
                    "read-only": "It only reads or reports. It writes no file, changes no repository state, installs nothing, and sends nothing to a network service.",
                    "reversible": "It changes something that can be undone, such as editing a file in the working tree, or a local commit.",
                    "irreversible": "It deletes, overwrites, publishes, deploys, or otherwise cannot be undone from here."
                }
            }
        });
        let state = format!("Tool: {tool}\nCommand:\n{command}");
        let Ok(answers) = self.decide(&state, &questions) else {
            return Screen::AskPerson;
        };
        match answers.get("effect") {
            Some(answer) if answer.value == "read-only" && answer.confidence >= ALLOW_AT => {
                Screen::Allow(answer.confidence)
            }
            _ => Screen::AskPerson,
        }
    }
}

/// Commands that are never handed to a model for an opinion.
///
/// The gate only sees commands the harness already wanted to refuse, and Jev
/// can only ever skip a person for read-only work. This list exists because
/// "read-only" is a judgment and these are not worth judging: a wrong answer
/// here cannot be undone, and the cost of asking a person is a few seconds.
const NEVER_AUTOMATIC: [&str; 8] = [
    "rm -rf",
    "mkfs",
    "dd if=",
    ":(){",
    "shutdown",
    "> /dev",
    "git push",
    "force-push",
];

/// How sure Jev must be before a command runs unwatched.
///
/// Jev is calibrated, so this reads as "wrong about one time in twenty", and
/// the cost of being wrong is one read-only command running unwatched.
const ALLOW_AT: f64 = 0.95;

/// What the approval gate decided without a person.
#[derive(Debug, PartialEq)]
pub enum Screen {
    /// Read-only, and Jev is sure enough. Let it run and do not wake anybody.
    Allow(f64),
    /// Anything else. The person decides, as they did before.
    AskPerson,
}

/// Screen a command with whatever gateway this process was given, if any.
pub fn screen_command(tool: &str, command: &str) -> Screen {
    match Jev::from_env() {
        Some(jev) => jev.screen_command(tool, command),
        None => Screen::AskPerson,
    }
}

/// One answer, on its way to the window.
#[derive(serde::Serialize)]
pub struct Decision {
    pub value: String,
    pub confidence: f64,
}

/// Ask from the window. The key stays here; the page never sees it.
///
/// The page builds the questions because the questions are about tickets,
/// tasks and worker output, all of which the page already holds.
#[tauri::command]
pub async fn jev_decide(
    app: tauri::AppHandle,
    state: String,
    questions: serde_json::Value,
) -> Result<HashMap<String, Decision>, String> {
    let settings = crate::harness_settings::read(&app);
    let jev = Jev::available(&settings).ok_or("Beta features are off.")?;
    // reqwest's blocking client cannot run on an async runtime thread.
    let answers = tauri::async_runtime::spawn_blocking(move || jev.decide(&state, &questions))
        .await
        .map_err(|error| error.to_string())??;
    Ok(answers
        .into_iter()
        .map(|(id, answer)| {
            (
                id,
                Decision {
                    value: answer.value,
                    confidence: answer.confidence,
                },
            )
        })
        .collect())
}

/// Which gateway the beta features will use, for the settings screen.
/// Empty when none is set up.
#[tauri::command]
pub fn jev_provider(app: tauri::AppHandle) -> String {
    Jev::available(&crate::harness_settings::read(&app))
        .map(|jev| jev.provider().label().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(openrouter: &str, vercel: &str, beta: bool) -> HarnessSettings {
        HarnessSettings {
            openrouter_key: openrouter.into(),
            vercel_key: vercel.into(),
            beta,
            ..Default::default()
        }
    }

    #[test]
    fn openrouters_yes_no_answer_carries_its_own_confidence() {
        let body = serde_json::json!({ "answers": { "stuck": { "noul": 0.9 } } });
        let answers = answers_of(&body);
        assert_eq!(answers["stuck"].value, "true");
        assert!((answers["stuck"].confidence - 0.9).abs() < 1e-9);
    }

    #[test]
    fn vercels_yes_no_answer_reads_the_same_way() {
        let body = serde_json::json!({ "answers": { "stuck": { "type": "boolean", "probability": 0.9 } } });
        let answers = answers_of(&body);
        assert_eq!(answers["stuck"].value, "true");
        assert!((answers["stuck"].confidence - 0.9).abs() < 1e-9);
    }

    #[test]
    fn a_confident_no_is_as_confident_as_a_confident_yes() {
        let body = serde_json::json!({ "answers": { "stuck": { "noul": 0.02 } } });
        let answers = answers_of(&body);
        assert_eq!(answers["stuck"].value, "false");
        assert!((answers["stuck"].confidence - 0.98).abs() < 1e-9);
    }

    #[test]
    fn a_choice_without_a_confidence_field_falls_back_to_its_distribution() {
        let body = serde_json::json!({ "answers": { "effect": {
            "type": "choice",
            "choice": "read-only",
            "probabilities": { "read-only": 0.8, "reversible": 0.15, "irreversible": 0.05 }
        } } });
        let answers = answers_of(&body);
        assert_eq!(answers["effect"].value, "read-only");
        assert!((answers["effect"].confidence - 0.8).abs() < 1e-9);
    }

    #[test]
    fn a_named_confidence_wins_over_the_distribution() {
        let body = serde_json::json!({ "answers": { "effect": {
            "choice": "read-only",
            "confidence": 0.33,
            "probabilities": { "read-only": 0.9 }
        } } });
        assert!((answers_of(&body)["effect"].confidence - 0.33).abs() < 1e-9);
    }

    #[test]
    fn vercels_interpolated_score_survives_as_a_number() {
        let body = serde_json::json!({ "answers": { "sev_0": {
            "type": "score", "score": 2.97, "probabilities": { "2": 0.02, "3": 0.98 }
        } } });
        assert_eq!(answers_of(&body)["sev_0"].value, "2.97");
    }

    #[test]
    fn an_unreadable_body_yields_no_answers_rather_than_a_guess() {
        assert!(answers_of(&serde_json::json!({ "error": "nope" })).is_empty());
    }

    #[test]
    fn a_yes_no_question_is_renamed_for_openrouter_and_left_alone_for_vercel() {
        let questions = serde_json::json!({
            "stuck": { "type": "boolean", "instructions": "Is it stuck?" },
            "effect": { "type": "choice", "criteria": { "a": "b" } }
        });
        let open = questions_for(Provider::OpenRouter, &questions);
        assert_eq!(open["stuck"]["type"], "noul");
        // Only the type changes. Everything else is passed through untouched.
        assert_eq!(open["stuck"]["instructions"], "Is it stuck?");
        assert_eq!(open["effect"]["type"], "choice");
        let vercel = questions_for(Provider::VercelGateway, &questions);
        assert_eq!(vercel["stuck"]["type"], "boolean");
    }

    #[test]
    fn no_key_means_no_client() {
        assert!(Jev::available(&settings("", "", true)).is_none());
    }

    #[test]
    fn a_key_without_the_beta_means_no_client() {
        assert!(Jev::available(&settings("sk-or-v1-x", "", false)).is_none());
    }

    #[test]
    fn either_key_on_its_own_is_enough() {
        assert_eq!(
            Jev::available(&settings("sk-or-v1-x", "", true))
                .unwrap()
                .provider(),
            Provider::OpenRouter
        );
        assert_eq!(
            Jev::available(&settings("", "vck_x", true))
                .unwrap()
                .provider(),
            Provider::VercelGateway
        );
    }

    #[test]
    fn with_both_keys_openrouter_answers() {
        assert_eq!(
            Jev::available(&settings("sk-or-v1-x", "vck_x", true))
                .unwrap()
                .provider(),
            Provider::OpenRouter
        );
    }

    #[test]
    fn whitespace_is_not_a_key() {
        assert!(Jev::available(&settings("   ", "  ", true)).is_none());
    }

    #[test]
    fn destructive_commands_never_reach_the_model() {
        let jev = Jev {
            provider: Provider::OpenRouter,
            key: "unused".into(),
        };
        // No call is made, so the key is never used: the list decides first.
        assert_eq!(
            jev.screen_command("Bash", "rm -rf /tmp/thing"),
            Screen::AskPerson
        );
        assert_eq!(
            jev.screen_command("Bash", "GIT_DIR=x git push --force origin main"),
            Screen::AskPerson
        );
    }

    #[test]
    fn without_a_gateway_every_command_still_goes_to_a_person() {
        assert_eq!(screen_command("Bash", "ls -la"), Screen::AskPerson);
    }
}
