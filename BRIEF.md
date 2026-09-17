# Threadroom — get the first real throughline in front of Scott

You're taking on the first working version of Threadroom: a standalone place where AI teammates and people can bring questions, review work, reply, and follow up without needing to meet in the same chat turn. Threads retain what was asked, what was shown, and what was answered after the original agent has moved on or disappeared.

Scott's immediate request is to “focus on getting a full throughline spike of the first bit, the website and api and ui and history and stuff asap so i can see it and see if direction is right”. The aim is something he can actually open and use soon, not a long architecture phase or a polished mock with no working backend.

## The work and its context

The [Threadroom Linear project](https://linear.app/scott-meyer/project/threadroom-1ae3add1fff1) has the full discussion and three ownership lanes:

- **Your focus: [SCO-182 — Build the standalone questions/reviews service and website](https://linear.app/scott-meyer/issue/SCO-182).**
- [SCO-180 — Deliver standalone async reviews with Pi and FlightDeck integrations](https://linear.app/scott-meyer/issue/SCO-180) holds the deep brief, original conversation, and final product outcome.
- [SCO-181 — Pi extension for async questions, answers, and session wake-ups](https://linear.app/scott-meyer/issue/SCO-181) and [SCO-183 — FlightDeck inbox and thread integration](https://linear.app/scott-meyer/issue/SCO-183) are later integrations, not prerequisites for this first demo.

The product name is now Threadroom; earlier notes call the Linear project “Async Reviews & Questions”. The full brief is context and a horizon, not a checklist to finish before showing Scott anything.

## What would make the spike useful

An API can publish a real question; the website shows it; Scott can inspect some work and answer in his own words; a follow-up belongs to the same thread; history retains the question, presentation, and response. Reloading the page or restarting the application doesn't erase the discussion. A visual review with images and choices would help Scott judge more than an empty generic form, and a programmatic client can retrieve what he answered.

The eventual presentations are things AIs can design for the discussion, not just a fixed questionnaire schema. Preserve that direction while choosing a small, credible slice. The service and its website own the conversation; Pi and FlightDeck will consume it later. No stack has been selected—bring your judgment about the quickest sound way to make this experience real.

You're a continuing teammate with room to investigate and build, not a one-shot reviewer. Say hi over intercom/Parley to the colleague who handed this over, `01a0b13f` (mistfall-control in mistfall-remote), so we know you're here and have the context. Let useful problems and evidence guide you rather than waiting for every next assignment.

Get the running experience in front of Scott early, with a working address and evidence from the actual browser. Make clear what's real and what's still a spike; feedback on direction is more valuable now than quietly finishing every production concern. Keep Linear informed as the work becomes concrete.
