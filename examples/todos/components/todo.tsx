/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { css, reactive, signal } from "@404/aether";

const Styled = css`
	:scope {
		max-width: 500px;
		margin: 2rem auto;
		font-family: sans-serif;
	}
	.input-row {
		display: flex;
		gap: 0.5rem;
	}
	input {
		flex: 1;
		padding: 0.5rem;
		border: 1px solid #ccc;
		border-radius: 4px;
	}
	button {
		padding: 0.5rem 1rem;
		border: none;
		border-radius: 4px;
		background: #646cff;
		color: white;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.todo-list {
		list-style: none;
		padding: 0;
		margin-top: 1rem;
	}
	.todo-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem;
		border-bottom: 1px solid #eee;
	}
	.todo-item.done label {
		text-decoration: line-through;
		color: #999;
	}
	label {
		flex: 1;
		cursor: pointer;
	}
	.delete-btn {
		background: #ff4d4d;
		color: white;
		border: none;
		border-radius: 4px;
		padding: 0.2rem 0.6rem;
		cursor: pointer;
	}
`;

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

let nextId = 1;

export default function Todos() {
	const todos = reactive<Todo[]>([
		{ id: nextId++, text: "meow", done: false },
		{ id: nextId++, text: "mrrp", done: true },
	]);
	const todo = signal("a little");

	const addTodo = () => {
		const text = todo().trim();
		if (!text) return;
		todos.push({ id: nextId++, text, done: false });
		todo.set("");
	};

	const toggleTodo = (todo: Todo) => {
		todo.done = !todo.done;
	};

	const deleteTodo = (id: number) => {
		const idx = todos.findIndex((t) => t.id === id);
		if (idx !== -1) todos.splice(idx, 1);
	};

	const remaining = todos.derive(($) => $.filter((t) => !t.done).length);
	const isEmpty = todos.derive(($) => $.length === 0);

	return (
		<Styled.div>
			<h2>Todo List</h2>
			<div class="input-row">
				<input
					type="text"
					bind:value={todo}
					placeholder="WHJATDOUWANT<:hazelfae:1480329521075851314>"
				/>
				<button type="button" on:click={addTodo} disabled={todo.map((t) => !t.trim())}>
					Add
				</button>
			</div>

			<show when={isEmpty}>
				<p>nothing here mate</p>
			</show>

			<ul class="todo-list">
				<for each={todos} key={(t) => t.id} fallback={<li class="todo-item">nothing yet</li>}>
					{(todo: () => Todo) => (
						<li class="todo-item" class:done={() => todo().done}>
							<input
								type="checkbox"
								checked={todo().done}
								on:change={() => toggleTodo(todo())}
							/>
							<label on:click={() => toggleTodo(todo())}>{todo().text}</label>
							<button type="button" class="delete-btn" onClick={() => deleteTodo(todo().id)}>
								✕
							</button>
						</li>
					) }
				</for>
			</ul>

			<p>
				<strong>
					{remaining} item{remaining.map((n) => (n !== 1 ? "s" : ""))} left
				</strong>
			</p>
		</Styled.div>
	);
}
