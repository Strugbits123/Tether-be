export interface Chapter {
  id: string;
  user_id: string;
  title: string;
  date_label: string | null;
  theme: string | null;
  type: 'text' | 'voice';
  body: string | null;
  word_count: number;
  status: 'draft' | 'in_progress' | 'complete';
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface ChapterExhibit {
  id: string;
  chapter_id: string;
  user_id: string;
  file_name: string;
  storage_path: string;
  file_type: string | null;
  file_size_bytes: number | null;
  width: number | null;
  height: number | null;
  display_order: number;
  created_at: string;
}
