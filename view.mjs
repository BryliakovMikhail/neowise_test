// Turns an API reply into what the manager sees. No DOM here, so it can be tested in Node.

export const TOPIC_LABELS = {
  delivery: "Доставка",
  pricing: "Цены и стоимость",
  other: "Другое",
};

const MANUAL_REVIEW_MESSAGE =
  "AI не смог разобрать заявку. Разберите её вручную: определите тему и подготовьте ответ сами.";

// Every view sets topic and draft explicitly, so a previous draft never stays on the screen.
export function toView(httpStatus, body) {
  if (httpStatus === 200 && body?.status === "ready") {
    return {
      kind: "ready",
      message: "Проверьте черновик перед отправкой клиенту.",
      topic: TOPIC_LABELS[body.topic] ?? body.topic,
      draft: body.draft,
    };
  }
  if (httpStatus === 400 && body?.status === "invalid_input") {
    return { kind: "error", message: "Введите текст заявки.", topic: "", draft: "" };
  }
  // manual_review, a server error or an unexpected reply: the manager works by hand.
  return { kind: "manual", message: MANUAL_REVIEW_MESSAGE, topic: "", draft: "" };
}
