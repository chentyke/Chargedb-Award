export type NotionPropertyValue = string | string[];

export type NotionProperty = {
  name: string;
  type: string;
  value: NotionPropertyValue;
};

export type NotionItem = {
  id: string;
  title: string;
  cover?: string;
  properties: NotionProperty[];
};

export type NotionResponse = {
  items: NotionItem[];
};
