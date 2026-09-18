//! Conversation identity and history belong to the backend, not a mounted view.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub organization_id: String,
    pub project_id: String,
    pub role: String,
    pub ticket_id: Option<String>,
    pub task_id: Option<String>,
}

impl Scope {
    pub fn key(&self) -> Result<String, String> {
        if self.project_id.trim().is_empty() {
            return Err("Choose a project before messaging an agent.".into());
        }
        let required = |value: &Option<String>| {
            value
                .clone()
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "This conversation needs a ticket or task ID.".to_string())
        };
        match self.role.as_str() {
            "ticket-agent" if self.ticket_id.is_none() && self.task_id.is_none() => {
                Ok(format!("ticket-agent:{}", self.project_id))
            }
            "task-agent" if self.task_id.is_none() => {
                Ok(format!("planner:{}", required(&self.ticket_id)?))
            }
            "pr-code-review" if self.task_id.is_none() => {
                Ok(format!("pr-code-review:{}", required(&self.ticket_id)?))
            }
            "worker" => {
                required(&self.ticket_id)?;
                let task = required(&self.task_id)?;
                if task.contains(':') {
                    return Err("Invalid worker task ID.".into());
                }
                Ok(task)
            }
            _ => Err("Invalid agent conversation scope.".into()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    pub id: String,
    pub text: String,
    pub target: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
    pub at: u128,
    pub delivery: Option<String>,
    pub target: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub agent_id: String,
    pub scope: Scope,
    pub revision: u64,
    pub messages: Vec<Message>,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub harness: String,
    pub activity: String,
    pub streaming: bool,
    pub worktree: Option<String>,
}

impl Conversation {
    pub fn pending(&self) -> Vec<UserMessage> {
        self.messages
            .iter()
            .filter(|m| m.delivery.as_deref() == Some("pending"))
            .map(|m| UserMessage {
                id: m.id.clone(),
                text: m.text.clone(),
                target: m.target.clone(),
            })
            .collect()
    }

    pub fn enqueue(&mut self, message: UserMessage) -> Result<(), String> {
        if message.id.trim().is_empty() || message.text.trim().is_empty() {
            return Err("A message needs an ID and text.".into());
        }
        if let Some(existing) = self.messages.iter_mut().find(|m| m.id == message.id) {
            if existing.text != message.text || existing.target != message.target {
                return Err("That message ID already belongs to another message.".into());
            }
            if existing.delivery.as_deref() == Some("failed") {
                existing.delivery = Some("pending".into());
                self.revision += 1;
            }
            return Ok(());
        }
        self.messages.push(Message {
            id: message.id,
            role: "user".into(),
            text: message.text,
            at: crate::human::now_ms(),
            delivery: Some("pending".into()),
            target: message.target,
        });
        self.revision += 1;
        Ok(())
    }

    pub fn delivery(&mut self, id: &str, delivery: &str) {
        if let Some(message) = self.messages.iter_mut().find(|m| m.id == id) {
            message.delivery = Some(delivery.into());
            self.revision += 1;
        }
    }

    pub fn append(&mut self, role: &str, text: String) {
        self.messages.push(Message {
            id: uuid::Uuid::new_v4().to_string(),
            role: role.into(),
            text,
            at: crate::human::now_ms(),
            delivery: None,
            target: None,
        });
        self.revision += 1;
    }
}

#[derive(Default)]
pub struct Conversations(pub HashMap<String, Conversation>);

impl Conversations {
    pub fn ensure(&mut self, scope: &Scope) -> Result<&mut Conversation, String> {
        let key = scope.key()?;
        let entry = self.0.entry(key.clone()).or_insert_with(|| Conversation {
            agent_id: key,
            scope: scope.clone(),
            revision: 0,
            messages: vec![],
            run_id: None,
            session_id: None,
            harness: "claude-code".into(),
            activity: "queued".into(),
            streaming: false,
            worktree: None,
        });
        if entry.scope != *scope {
            return Err(
                "This conversation belongs to a different project, ticket, or agent.".into(),
            );
        }
        Ok(entry)
    }

    pub fn for_run(&mut self, key: &str, run_id: &str) -> Option<&mut Conversation> {
        self.0
            .get_mut(key)
            .filter(|thread| thread.run_id.as_deref() == Some(run_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope(project: &str, ticket: &str, task: &str) -> Scope {
        Scope {
            organization_id: "org".into(),
            project_id: project.into(),
            role: "worker".into(),
            ticket_id: Some(ticket.into()),
            task_id: Some(task.into()),
        }
    }
    fn message(id: &str, text: &str) -> UserMessage {
        UserMessage {
            id: id.into(),
            text: text.into(),
            target: None,
        }
    }
    #[test]
    fn messages_and_replies_stay_on_their_worker() {
        let mut book = Conversations::default();
        for task in ["a", "b"] {
            let thread = book.ensure(&scope("project", "ticket", task)).unwrap();
            thread.run_id = Some(format!("run-{task}"));
        }
        book.ensure(&scope("project", "ticket", "a"))
            .unwrap()
            .enqueue(message("msg", "only A"))
            .unwrap();
        book.for_run("b", "run-b")
            .unwrap()
            .append("agent", "only B".into());
        assert_eq!(book.0["a"].messages[0].text, "only A");
        assert_eq!(book.0["b"].messages[0].text, "only B");
        assert_eq!(book.0["a"].messages.len(), 1);
    }
    #[test]
    fn scope_cannot_be_rebound_by_switching_projects_or_tickets() {
        let mut book = Conversations::default();
        book.ensure(&scope("p1", "t1", "a")).unwrap();
        assert!(book.ensure(&scope("p2", "t1", "a")).is_err());
        assert!(book.ensure(&scope("p1", "t2", "a")).is_err());
        assert!(scope("", "t1", "a").key().is_err());
    }
    #[test]
    fn stale_run_cannot_append_or_finish_a_replacement() {
        let mut book = Conversations::default();
        book.ensure(&scope("p", "t", "a")).unwrap().run_id = Some("new".into());
        assert!(book.for_run("a", "old").is_none());
        assert!(book.for_run("a", "new").is_some());
    }
    #[test]
    fn queued_messages_keep_ids_order_and_delivery_without_duplicates() {
        let mut book = Conversations::default();
        let thread = book.ensure(&scope("p", "t", "a")).unwrap();
        thread.enqueue(message("one", "first")).unwrap();
        thread.enqueue(message("two", "second")).unwrap();
        thread.enqueue(message("one", "first")).unwrap();
        assert_eq!(
            thread
                .pending()
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
        thread.delivery("one", "delivered");
        thread.delivery("two", "failed");
        assert!(thread.pending().is_empty());
        thread.enqueue(message("two", "second")).unwrap();
        assert_eq!(thread.pending()[0].id, "two");
        assert_eq!(thread.messages.len(), 2);
    }
}
