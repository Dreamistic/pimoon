import { Type } from "typebox";

export const writeParameters = Type.Object(
	{
		path: Type.String({ description: "New or previously read file path." }),
		content: Type.String(),
	},
	{ additionalProperties: false },
);
