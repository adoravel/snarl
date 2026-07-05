export interface Todo {
	id: number;
	title: string;
	completed: boolean;
	tags: string[];
}

export const largePayload: Todo[] = Array.from({ length: 100 }, (_, i) => ({
	id: i,
	title: `Task number ${i} or smth iunno`,
	completed: i % 3 === 0,
	tags: ["bench", "todo", i % 2 === 0 ? "even" : "odd"],
}));

export const echoPayload = {
	name: "snarl",
	version: "1.0.0",
	tags: ["fast", "minimal", "deno", "also quite cute tbh"],
};

export const echoPayloadJson: string = JSON.stringify(echoPayload);
